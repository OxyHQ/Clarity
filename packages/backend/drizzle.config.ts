import { DATABASE_CASING } from '@oxyhq/db';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  casing: DATABASE_CASING,
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});

