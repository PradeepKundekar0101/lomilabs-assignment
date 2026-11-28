import type { RequestHandler } from "express";

/**
 * Lets the review UI on one other origin (Vercel) call the api. Uploads are simple requests;
 * a review's JSON body needs the preflight answered here.
 */
export function cors(origin: string): RequestHandler {
  return (req, res, next) => {
    res.vary("Origin");
    if (req.headers.origin !== origin) return next();
    res.set("Access-Control-Allow-Origin", origin);
    if (req.method !== "OPTIONS") return next();
    res
      .set({ "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" })
      .sendStatus(204);
  };
}
