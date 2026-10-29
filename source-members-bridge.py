#!/usr/bin/env python3
"""Read-only Java member range detector using the FastEdit tree-sitter runtime.

The request contains source text already fetched through the caller's file
permission path. This bridge never reads or executes the project's source.
"""

from __future__ import annotations

import json
import sys
from typing import Any


MAX_SOURCE_BYTES = 4_000_000
MAX_MEMBERS = 8

CONTAINER_TYPES = {
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "annotation_type_declaration",
}
METHOD_TYPES = {
    "method_declaration",
    "constructor_declaration",
    "compact_constructor_declaration",
}
FIELD_TYPES = {"field_declaration", "constant_declaration"}
OTHER_MEMBER_TYPES = {
    "annotation_type_element_declaration": "annotation-element",
    "enum_constant": "enum-constant",
}


def fail(reason: str, **extra: object) -> int:
    print(json.dumps({"ok": False, "reason": reason, **extra}, ensure_ascii=False))
    return 0


def node_name(node: Any, source: bytes) -> str:
    field = node.child_by_field_name("name")
    if field is None:
        for child in node.named_children:
            if child.type in {"identifier", "type_identifier"}:
                field = child
                break
    if field is None:
        return ""
    return source[field.start_byte : field.end_byte].decode("utf-8")


def qualified_symbol(parents: list[str], name: str) -> str:
    return ".".join([*parents, name]) if parents else name


def add_match(
    matches: list[dict[str, object]],
    node: Any,
    source: bytes,
    name: str,
    kind: str,
    parents: list[str],
    declared_names: list[str] | None = None,
) -> None:
    if not name or name == "<anonymous>":
        return
    text = source[node.start_byte : node.end_byte]
    matches.append(
        {
            "name": name,
            "qualifiedSymbol": qualified_symbol(parents, name),
            "kind": kind,
            "lineStart": node.start_point[0] + 1,
            "lineEnd": node.end_point[0] + 1,
            "startColumn": node.start_point[1],
            "endColumn": node.end_point[1],
            "startByte": node.start_byte,
            "endByte": node.end_byte,
            "textBytes": len(text),
            **(
                {"declaredNames": declared_names}
                if declared_names and len(declared_names) > 1
                else {}
            ),
        }
    )


def collect_members(node: Any, source: bytes, parents: list[str], matches: list[dict[str, object]]) -> None:
    node_type = node.type

    if node_type in CONTAINER_TYPES:
        name = node_name(node, source)
        add_match(matches, node, source, name, node_type.removesuffix("_declaration"), parents)
        next_parents = [*parents, name] if name else parents
        if node_type == "record_declaration":
            parameters = node.child_by_field_name("parameters")
            if parameters is None:
                parameters = next(
                    (child for child in node.named_children if child.type == "formal_parameters"),
                    None,
                )
            if parameters is not None:
                for child in parameters.named_children:
                    if child.type == "formal_parameter":
                        add_match(
                            matches,
                            child,
                            source,
                            node_name(child, source),
                            "record-component",
                            next_parents,
                        )
        for child in node.named_children:
            collect_members(child, source, next_parents, matches)
        return

    if node_type in METHOD_TYPES:
        name = node_name(node, source)
        if node_type == "compact_constructor_declaration" and not name and parents:
            name = parents[-1]
        add_match(matches, node, source, name, "constructor" if "constructor" in node_type else "method", parents)
        return

    if node_type in FIELD_TYPES:
        names: list[str] = []
        for child in node.named_children:
            if child.type == "variable_declarator":
                name = node_name(child, source)
                if name and name not in names:
                    names.append(name)
        if not names:
            name = node_name(node, source)
            if name:
                names.append(name)
        for name in names:
            add_match(matches, node, source, name, "field", parents, names)
        return

    kind = OTHER_MEMBER_TYPES.get(node_type)
    if kind:
        add_match(matches, node, source, node_name(node, source), kind, parents)
        if node_type != "enum_constant":
            return

    for child in node.named_children:
        collect_members(child, source, parents, matches)


def select(matches: list[dict[str, object]], requested: str) -> list[dict[str, object]]:
    leaf = requested.rsplit(".", 1)[-1]
    selected = []
    for match in matches:
        name = str(match["name"])
        qualified = str(match["qualifiedSymbol"])
        if requested == name or requested == qualified or requested.endswith("." + qualified):
            selected.append(match)
        elif "." not in requested and leaf == name:
            selected.append(match)
    return selected


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except Exception as error:
        return fail("invalid-json", detail=str(error))

    source_text = request.get("source")
    members = request.get("members")
    if not isinstance(source_text, str):
        return fail("source-required")
    if (
        not isinstance(members, list)
        or not members
        or len(members) > MAX_MEMBERS
        or any(not isinstance(item, str) or not item for item in members)
    ):
        return fail("invalid-members")

    source = source_text.encode("utf-8")
    if len(source) > MAX_SOURCE_BYTES:
        return fail("source-too-large", bytes=len(source), maxBytes=MAX_SOURCE_BYTES)

    try:
        from fastedit.data_gen.ast_analyzer import get_parser

        parser = get_parser("java")
        tree = parser.parse(source)
    except Exception as error:
        return fail("tree-sitter-unavailable", detail=str(error))

    if tree.root_node.has_error:
        error_nodes = sum(1 for node in tree.root_node.named_children if node.is_error)
        return fail("parse-errors", errorNodes=error_nodes)

    matches: list[dict[str, object]] = []
    collect_members(tree.root_node, source, [], matches)
    available = sorted({str(match["qualifiedSymbol"]) for match in matches})
    results = []
    for requested in members:
        selected = select(matches, requested)
        results.append(
            {
                "request": requested,
                "total": len(selected),
                "matches": selected[:100],
            }
        )

    print(
        json.dumps(
            {
                "ok": True,
                "language": "java",
                "sourceBytes": len(source),
                "results": results,
                "available": available[:200],
                "availableTruncated": len(available) > 200,
                "parser": "fastedit-tree-sitter-java",
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
