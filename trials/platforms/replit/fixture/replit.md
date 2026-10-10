# Widget Shop

## Overview

A small online store built with Replit Agent. Five products, users and
orders live in Replit's Postgres database. Pages are server-rendered HTML from
Express; there is no React, Vue, Svelte, or Angular app.

## User Preferences

Preferred communication style: simple, everyday language.

## System Architecture

- `server.js`: the Express server. Listens on port 5000 on `0.0.0.0`.
- `lib/shop.js`: products, users and orders, with plain SQL through `pg`.
  `setupDatabase()` creates the tables and the products at every start.
- `lib/db.js`: one `pg` pool on `DATABASE_URL`.
- Published as an Autoscale deployment (`.replit`).

## External Dependencies

- PostgreSQL 16, provided by Replit through `DATABASE_URL`. A published app
  gets its own production database.
- Secrets are set in the Replit Secrets tool and read from `process.env`.
