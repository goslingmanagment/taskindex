import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import {fileURLToPath} from 'node:url';
export default defineConfig({
 root: fileURLToPath(new URL('.',import.meta.url)),
 cacheDir: '/tmp/taskindex-ui-reference-20260908/vite-cache',
 resolve: {alias:{'@': fileURLToPath(new URL('.',import.meta.url))}},
 plugins:[react()],
 css: {postcss:{plugins:[tailwindcss()]}},
 server: {host:'127.0.0.1',port:4328,strictPort:true,watch:{useFsEvents:false,usePolling:true}},
});
