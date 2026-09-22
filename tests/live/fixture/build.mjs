import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('out', { recursive: true });
writeFileSync('out/sum.txt', String(40 + 2));
console.log('build ok');
