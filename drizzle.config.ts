import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle/v2',
  schema: './src/server/schema.ts',
  dialect: 'sqlite',
});
