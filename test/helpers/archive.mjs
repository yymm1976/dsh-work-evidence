import {crc32} from 'node:zlib';
export function buildZip(entries){
  const localParts=[];
  const centralParts=[];
  let offset=0;

  for(const item of entries){
    const name=Buffer.from(item.name,'utf8');
    const source=Buffer.from(item.data);
    const checksum=crc32(source);
    const flags=0x0800;

    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4);
    local.writeUInt16LE(flags,6);
    local.writeUInt16LE(0,8);
    local.writeUInt32LE(checksum,14);
    local.writeUInt32LE(source.length,18);
    local.writeUInt32LE(source.length,22);
    local.writeUInt16LE(name.length,26);
    localParts.push(local,name,source);

    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);
    central.writeUInt16LE(20,4);
    central.writeUInt16LE(20,6);
    central.writeUInt16LE(flags,8);
    central.writeUInt16LE(0,10);
    central.writeUInt32LE(checksum,16);
    central.writeUInt32LE(source.length,20);
    central.writeUInt32LE(source.length,24);
    central.writeUInt16LE(name.length,28);
    central.writeUInt32LE(offset,42);
    centralParts.push(central,name);

    offset+=local.length+name.length+source.length;
  }

  const centralDirectory=Buffer.concat(centralParts);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(centralDirectory.length,12);
  end.writeUInt32LE(offset,16);
  return Buffer.concat([...localParts,centralDirectory,end]);
}

