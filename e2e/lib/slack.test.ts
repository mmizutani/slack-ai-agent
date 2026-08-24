import { isBotMessage } from "./slack";

const BOT = "U0BOT";
const DRIVER = "U0DRIVER";

describe("isBotMessage", () => {
  it("recognises the bot's own reply", () => {
    expect(isBotMessage({ ts: "1", user: BOT, bot_id: "B1" }, BOT)).toBe(true);
  });

  it("does not treat the driver's message as the bot's reply", () => {
    // The driver posts with a user token belonging to this same Slack app, so
    // Slack stamps bot_id and app_id on it. Keying off bot_id made every
    // driver message look like a bot reply, and a cycle could satisfy itself
    // with the very message it had just sent.
    expect(isBotMessage({ ts: "2", user: DRIVER, bot_id: "B2" }, BOT)).toBe(
      false,
    );
  });

  it("does not treat a plain human message as the bot's reply", () => {
    expect(isBotMessage({ ts: "3", user: DRIVER }, BOT)).toBe(false);
  });

  it("does not treat a third-party bot's message as this bot's reply", () => {
    expect(isBotMessage({ ts: "4", user: "U0OTHER", bot_id: "B3" }, BOT)).toBe(
      false,
    );
  });

  it("ignores a message with no author rather than claiming it", () => {
    expect(isBotMessage({ ts: "5" }, BOT)).toBe(false);
  });
});
