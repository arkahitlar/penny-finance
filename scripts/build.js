import { cp, mkdir } from 'node:fs/promises';

// Publish only browser assets. Server code and secrets never enter dist/.
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
await cp(new URL('../public/', import.meta.url), new URL('../dist/', import.meta.url), { recursive: true });
console.log('Built static frontend in dist/. Vercel builds api/ as Node.js functions.');
