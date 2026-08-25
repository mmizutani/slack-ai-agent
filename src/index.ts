// config is imported before tracing so dotenv.config() runs first to set environment variables.
import "./config";
import "./tracing";
import { startApp } from "./app";
import { Logger } from "./logger";

const logger = new Logger("Main");

// Bolt's constructor fires auth.test immediately when token verification is
// enabled and leaves the promise floating, so an invalid token arrives here
// rather than at the catch below. Without this it surfaces as a raw stack from
// inside node and the process dies with no context.
process.on("unhandledRejection", reason => {
  logger.error("Unhandled promise rejection", reason);
  process.exit(1);
});

startApp().catch(error => {
  logger.error("Failed to start the bot", error);
  process.exit(1);
});
