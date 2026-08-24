import { containsMarker, markerFor, newRunId } from "./markers";

describe("newRunId", () => {
  it("produces a short hex id", () => {
    expect(newRunId()).toMatch(/^[0-9a-f]{8}$/);
  });

  it("produces a different id each call so runs never collide", () => {
    expect(newRunId()).not.toBe(newRunId());
  });
});

describe("markerFor", () => {
  it("is stable for the same run and cycle", () => {
    expect(markerFor("abc12345", "dm")).toBe(markerFor("abc12345", "dm"));
  });

  it("distinguishes cycles within a run", () => {
    expect(markerFor("abc12345", "dm")).not.toBe(
      markerFor("abc12345", "channel-mention"),
    );
  });

  it("distinguishes runs for the same cycle", () => {
    expect(markerFor("abc12345", "dm")).not.toBe(markerFor("def67890", "dm"));
  });
});

describe("containsMarker", () => {
  const marker = markerFor("abc12345", "dm");

  it("finds the marker in a conversational reply", () => {
    expect(containsMarker(`Sure thing — ${marker}`, marker)).toBe(true);
  });

  it("finds a marker that is the entire reply", () => {
    expect(containsMarker(marker, marker)).toBe(true);
  });

  it("rejects a reply that does not contain it", () => {
    expect(containsMarker("I could not help with that", marker)).toBe(false);
  });

  it("does not match a longer marker that merely starts with it", () => {
    // Without a boundary check, cycle "dm" would be satisfied by the reply
    // belonging to cycle "dm-followup", turning a real failure green.
    const longer = markerFor("abc12345", "dm-followup");
    expect(containsMarker(`reply ${longer}`, marker)).toBe(false);
  });

  it("does not match when the marker is a suffix of a longer token", () => {
    expect(containsMarker(`prefix${marker}`, marker)).toBe(false);
  });

  it("accepts a marker followed by punctuation", () => {
    expect(containsMarker(`Done: ${marker}.`, marker)).toBe(true);
  });
});
