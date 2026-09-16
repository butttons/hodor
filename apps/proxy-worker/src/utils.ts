/**
 * Shared router factory + central context typing (cf-mono / feedr convention).
 * @module
 */
import { Hono } from "hono";
import { TrieRouter } from "hono/router/trie-router";
import type { AppEnv } from "@/lib/auth";

/** A Hono app with the shared env (Bindings + JWT payload vars) + a trie router. */
export const createRouter = () => new Hono<AppEnv>({ router: new TrieRouter() });

export type { AppEnv } from "@/lib/auth";
