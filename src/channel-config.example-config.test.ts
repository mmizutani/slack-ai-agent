import fs from "fs";
import { ChannelConfigManager } from "./channel-config";

/**
 * Guards the shipped example configuration, not just a hand-written fixture.
 *
 * config/example-channels.yaml declares `ephemeralChannelConfig:` and
 * `dmNotificationConfig:` with every entry commented out, so js-yaml parses
 * them as null rather than {}. The existing channel-config tests mock
 * readFileSync to return `{}` for those keys, so nothing exercised the shape a
 * fresh checkout actually loads.
 */
describe("channel config loaded from the shipped example file", () => {
  let existsSync: jest.SpyInstance;

  beforeEach(() => {
    // Force the example-file fallback regardless of whether the developer
    // running the suite happens to have a real config/channels.yaml.
    existsSync = jest.spyOn(fs, "existsSync").mockReturnValue(false);
  });

  afterEach(() => {
    existsSync.mockRestore();
  });

  it("reports no ephemeral routing instead of throwing on a null map", async () => {
    const manager = new ChannelConfigManager();

    await expect(
      manager.shouldUseEphemeralMessaging("C0BRUSM9M4P"),
    ).resolves.toBe(false);
  });

  it("returns no ephemeral target users for an unconfigured channel", async () => {
    const manager = new ChannelConfigManager();

    await expect(
      manager.getEphemeralTargetUsers("C0BRUSM9M4P"),
    ).resolves.toEqual([]);
  });

  it("returns no ephemeral target channels for an unconfigured channel", async () => {
    const manager = new ChannelConfigManager();

    await expect(
      manager.getEphemeralTargetChannels("C0BRUSM9M4P"),
    ).resolves.toEqual([]);
  });

  it("sends no DM notification for an unconfigured channel", async () => {
    const manager = new ChannelConfigManager();

    await expect(
      manager.shouldSendDM("C0BRUSM9M4P", "U1LBQTL8G"),
    ).resolves.toBe(false);
  });
});
