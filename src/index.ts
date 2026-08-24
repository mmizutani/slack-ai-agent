// config is imported before tracing so dotenv.config() runs first to set environment variables.
import "./config";
import "./tracing";
import { startApp } from "./app";
import { Logger } from "./logger";

const logger = new Logger("Main");

startApp().catch(error => {
  logger.error("Failed to start the bot", error);
  process.exit(1);
});
