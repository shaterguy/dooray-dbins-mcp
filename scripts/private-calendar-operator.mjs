import {fileURLToPath} from 'node:url';
import {callPrivateOperator} from '../src/private-calendar-operator.mjs';
const chunks=[];let n=0;
try{for await(const part of process.stdin){n+=part.length;if(n>16384)throw Error('REQUEST_LIMIT');chunks.push(part)}
 const msg=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 const out=await callPrivateOperator(fileURLToPath(new URL('../',import.meta.url)),msg);process.stdout.write(JSON.stringify(out)+'\n');if(out.error)process.exitCode=1;
}catch{process.stderr.write('Local calendar call not verified; do not repeat a mutation automatically.\n');process.exitCode=2;}