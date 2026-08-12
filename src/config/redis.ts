import { Redis } from "ioredis";

if (!process.env.REDIS_URL) {
  throw new Error("REDIS_URL is not configured");
}

export const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
// const redis = new Redis({
//   host: process.env.REDIS_HOST,
//   port: parseInt(process.env.REDIS_PORT || "6379"),
//   maxRetriesPerRequest: null,
// });

export default redis;
