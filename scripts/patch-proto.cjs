'use strict';
// Relaxes the bundled rustplus.proto so modded servers that omit "required"
// fields (e.g. queuedPlayers on some x1000 servers) don't crash the protobuf
// decoder. Runs automatically as an npm "postinstall" step.
const fs = require('fs');
const path = require('path');

const protoPath = path.join(__dirname, '..', 'node_modules', '@liamcottle', 'rustplus.js', 'rustplus.proto');

try {
  let proto = fs.readFileSync(protoPath, 'utf8');
  const count = (proto.match(/\brequired\b/g) || []).length;
  if (count > 0) {
    proto = proto.replace(/\brequired\b/g, 'optional');
    fs.writeFileSync(protoPath, proto);
    console.log(`[patch-proto] relaxed ${count} 'required' fields -> 'optional'`);
  } else {
    console.log('[patch-proto] already patched (no required fields)');
  }
} catch (e) {
  console.warn('[patch-proto] skipped:', e.message);
}
