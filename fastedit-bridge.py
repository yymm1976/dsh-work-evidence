#!/usr/bin/env python3
"""Deterministic Java edit bridge using FastEdit's tree-sitter components.

This process never uses FastEdit's local 1.7B merge model and never writes the
user's source file. It reads a JSON request from stdin, writes the proposed
merged text to result_file, and prints only a compact JSON receipt.
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def fail(reason: str, **extra: object) -> int:
    print(json.dumps({"ok": False, "reason": reason, **extra}, ensure_ascii=False))
    return 0


def main() -> int:
    try:
        if len(sys.argv) > 1:
            request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        else:
            request = json.load(sys.stdin)
    except Exception as error:
        return fail("invalid-json", detail=str(error))

    file_path = request.get("file")
    operation = request.get("operation")
    symbol = request.get("symbol")
    snippet = request.get("snippet")
    result_file = request.get("result_file")
    workspace_root = request.get("workspace_root")
    if not all(isinstance(value, str) and value for value in [workspace_root, file_path, operation]):
        return fail("invalid-request")
    if symbol is not None and not isinstance(symbol, str):
        return fail("invalid-symbol")
    if not file_path.lower().endswith(".java"):
        return fail("unsupported-language")
    edit_ops = {"after_symbol", "replace_symbol", "replace_symbol_full"}
    read_ops = {"find_entity", "read_entity"}
    if operation not in edit_ops | read_ops:
        return fail("unsupported-operation")
    if operation in edit_ops and not isinstance(snippet, str):
        return fail("snippet-required")
    if operation in edit_ops | {"read_entity"} and not isinstance(result_file, str):
        return fail("result-file-required")
    if snippet is not None and len(snippet.encode("utf-8")) > 250_000:
        return fail("snippet-too-large")

    try:
        from fastedit.data_gen.ast_analyzer import validate_parse
        from fastedit.inference.ast_utils import (
            _qualified_symbol_names,
            get_ast_map_from_source,
        )
        from fastedit.inference.text_match import deterministic_edit
    except Exception as error:
        return fail("fastedit-import-failed", detail=str(error))

    root = Path(workspace_root).resolve()
    path = Path(file_path)
    if not path.is_file():
        return fail("file-not-found")
    resolved_path = path.resolve()
    if root != resolved_path and root not in resolved_path.parents:
        return fail("path-outside-workspace")
    if isinstance(result_file, str):
        resolved_result = Path(result_file).resolve()
        if root != resolved_result and root not in resolved_result.parents:
            return fail("result-path-outside-workspace")
    source_bytes = resolved_path.read_bytes()
    if len(source_bytes) > 4_000_000:
        return fail("source-too-large")
    try:
        source = source_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        return fail("source-encoding-not-utf8", detail=str(error))
    newline = "\r\n" if "\r\n" in source else "\n"
    if snippet is not None:
        snippet = snippet.replace("\r\n", "\n").replace("\r", "\n").replace("\n", newline)
    nodes = get_ast_map_from_source(source, file_path)
    if not nodes:
        return fail("ast-unavailable")
    lines = source.splitlines(keepends=True)

    if operation == "after_symbol":
        matches = [
            node
            for node in nodes
            if node.name == symbol
            or (node.parent and f"{node.parent}.{node.name}" == symbol)
        ]
    elif operation in {"find_entity", "read_entity", "replace_symbol", "replace_symbol_full"}:
        matches = [
            node
            for node in nodes
            if node.name == symbol
            or (node.parent and f"{node.parent}.{node.name}" == symbol)
        ]
    if operation == "find_entity":
        candidates = []
        for node in matches:
            start = max(0, int(node.line_start) - 1)
            end = min(len(lines), int(node.line_end))
            entity = "".join(lines[start:end])
            candidates.append(
                {
                    "name": node.name,
                    "qualified_symbol": f"{node.parent}.{node.name}" if node.parent else node.name,
                    "kind": node.kind,
                    "line_start": node.line_start,
                    "line_end": node.line_end,
                    "bytes": len(entity.encode("utf-8")),
                }
            )
        print(
            json.dumps(
                {
                    "ok": True,
                    "operation": operation,
                    "language": "java",
                    "symbol": symbol,
                    "before_sha256": sha256(source),
                    "before_bytes": len(source_bytes),
                    "total": len(candidates),
                    "matches": candidates[:100],
                    "truncated": len(candidates) > 100,
                    "available": [] if candidates else _qualified_symbol_names(nodes)[:200],
                },
                ensure_ascii=False,
            )
        )
        return 0
    if not matches:
        return fail(
            "symbol-not-found",
            available=_qualified_symbol_names(nodes)[:200],
        )
    if len(matches) > 1:
        return fail(
            "symbol-ambiguous",
            candidates=[
                f"{node.parent}.{node.name}" if node.parent else node.name
                for node in matches[:20]
            ],
        )

    node = matches[0]
    start = max(0, int(node.line_start) - 1)
    end = min(len(lines), int(node.line_end))
    if start >= end:
        return fail("invalid-ast-range")

    if operation == "read_entity":
        entity = "".join(lines[start:end])
        entity_bytes = entity.encode("utf-8")
        if len(entity_bytes) > 64_000:
            return fail(
                "entity-too-large",
                qualified_symbol=f"{node.parent}.{node.name}" if node.parent else node.name,
                line_start=node.line_start,
                line_end=node.line_end,
                bytes=len(entity_bytes),
                next="Use an OPS range read for this entity.",
            )
        output = Path(result_file)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(entity_bytes)
        print(
            json.dumps(
                {
                    "ok": True,
                    "operation": operation,
                    "language": "java",
                    "symbol": node.name,
                    "qualified_symbol": f"{node.parent}.{node.name}" if node.parent else node.name,
                    "kind": node.kind,
                    "line_start": node.line_start,
                    "line_end": node.line_end,
                    "before_sha256": sha256(source),
                    "entity_sha256": sha256(entity),
                    "before_bytes": len(source_bytes),
                    "entity_bytes": len(entity_bytes),
                },
                ensure_ascii=False,
            )
        )
        return 0

    if operation == "after_symbol":
        insertion = snippet if snippet.endswith("\n") else snippet + "\n"
        merged = "".join(lines[:end]) + insertion + "".join(lines[end:])
        used = "fastedit-tree-sitter-insert"
    elif operation == "replace_symbol_full":
        replacement = snippet if snippet.endswith("\n") else snippet + "\n"
        merged = "".join(lines[:start]) + replacement + "".join(lines[end:])
        used = "fastedit-tree-sitter-full-replace"
    else:
        original_symbol = "".join(lines[start:end])
        edited = deterministic_edit(original_symbol, snippet)
        if edited is None:
            return fail(
                "deterministic-match-unavailable",
                note="Use more exact context anchors or replace_symbol_full; this adapter does not invoke a merge model.",
            )
        if original_symbol.endswith("\n") and not edited.endswith("\n"):
            edited += "\n"
        merged = "".join(lines[:start]) + edited + "".join(lines[end:])
        used = "fastedit-deterministic-text-match"

    parse_valid = validate_parse(merged, "java")
    if not parse_valid:
        return fail("parse-invalid", used=used, symbol=node.name)

    output = Path(result_file)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(merged.encode("utf-8"))
    print(
        json.dumps(
            {
                "ok": True,
                "operation": operation,
                "language": "java",
                "symbol": node.name,
                "qualified_symbol": f"{node.parent}.{node.name}" if node.parent else node.name,
                "line_start": node.line_start,
                "line_end": node.line_end,
                "before_sha256": sha256(source),
                "after_sha256": sha256(merged),
                "before_bytes": len(source.encode("utf-8")),
                "after_bytes": len(merged.encode("utf-8")),
                "parse_valid": True,
                "used": used,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
