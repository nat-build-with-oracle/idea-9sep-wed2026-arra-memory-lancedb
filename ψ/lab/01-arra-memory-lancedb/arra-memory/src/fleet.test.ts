/**
 * The fleet layer, against a REAL broker.
 *
 * A fake MQTT client would prove our own mock behaves as we wrote it. What
 * needs proving is the part we do not control: that retained messages replay
 * to a fresh subscriber, that an empty retained payload is delivered at all
 * (it is, and it means "cleared"), and that our topic filters match what a
 * real broker matches. So this spawns mosquitto on an ephemeral port.
 *
 * Skips itself — loudly — if mosquitto is absent, rather than passing quietly
 * on a machine that never ran the interesting half.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import mqtt from "mqtt";

const PORT = 21883 + Math.floor(Math.random() * 500);
const HAVE = Bun.which("mosquitto") !== null;
let broker: ReturnType<typeof spawn> | null = null;

beforeAll(async () => {
  if (!HAVE) return;
  broker = spawn("mosquitto", ["-p", String(PORT)], { stdio: "ignore" });
  // The port is the readiness signal, not a fixed sleep: poll until a real
  // client connects, so a slow machine does not fail a correct implementation.
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise<boolean>((res) => {
      const c = mqtt.connect(`mqtt://127.0.0.1:${PORT}`, { connectTimeout: 300, reconnectPeriod: 0 });
      c.on("connect", () => { c.end(true); res(true); });
      c.on("error", () => { c.end(true); res(false); });
    });
    if (ok) return;
    await Bun.sleep(100);
  }
  throw new Error("mosquitto did not accept a connection");
});

afterAll(() => broker?.kill());

/** Load fleet.ts with env pointed at the test broker. Imported lazily because
 *  config.ts resolves settings once at import. */
async function loadFleet(extra: Record<string, string> = {}) {
  process.env.MQTT_URL = `mqtt://127.0.0.1:${PORT}`;
  process.env.MQTT_PREFIX = "oracle";
  process.env.INSTANCE_NAME = "test-memory";
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  return await import("./fleet");
}

const skip = HAVE ? test : test.skip;
if (!HAVE) console.warn("[fleet.test] mosquitto not installed — the broker tests did NOT run");

skip("retained presence replays to a fresh subscriber, and empty retain means departed", async () => {
  const pub = mqtt.connect(`mqtt://127.0.0.1:${PORT}`);
  await new Promise((r) => pub.on("connect", r));

  // Two members publish retained state BEFORE we ever connect — the whole point
  // of retain is that a later subscriber still learns it.
  pub.publish("oracle/alpha/lwt", "online", { qos: 1, retain: true });
  pub.publish("oracle/alpha/status", JSON.stringify({ online: true, client: "oracle-channel" }), { qos: 1, retain: true });
  pub.publish("oracle/ghost/lwt", "online", { qos: 1, retain: true });
  await Bun.sleep(150);

  const fleet = await loadFleet();
  fleet.startFleet();
  await Bun.sleep(600);

  const seen = fleet.listFleet();
  expect(seen.ok).toBe(true);
  if (!seen.ok) return;
  const names = seen.members.map((m) => m.name).sort();
  expect(names).toContain("alpha");
  expect(names).toContain("ghost");

  // alpha announced a channel; ghost did not. That distinction is what tells a
  // model which members can actually be MESSAGED, so it must survive.
  expect(seen.members.find((m) => m.name === "alpha")?.channel).toBe(true);
  expect(seen.members.find((m) => m.name === "ghost")?.channel).toBeUndefined();

  // An EMPTY retained payload is a clean departure — the row goes away rather
  // than lingering as "offline", which is what a death looks like.
  pub.publish("oracle/ghost/lwt", "", { qos: 1, retain: true });
  await Bun.sleep(400);
  const after = fleet.listFleet();
  if (!after.ok) throw new Error("lost connection");
  expect(after.members.map((m) => m.name)).not.toContain("ghost");
  expect(after.members.map((m) => m.name)).toContain("alpha");

  pub.end(true);
});

skip("send publishes to the exact contract topic, and resolves on PUBACK", async () => {
  const fleet = await loadFleet();
  fleet.startFleet();
  await Bun.sleep(400);

  const sub = mqtt.connect(`mqtt://127.0.0.1:${PORT}`);
  await new Promise((r) => sub.on("connect", r));
  await new Promise((r) => sub.subscribe("oracle/+/+/in", { qos: 1 }, () => r(null)));

  const got = new Promise<{ topic: string; body: any }>((res) => {
    sub.on("message", (topic, p) => res({ topic, body: JSON.parse(p.toString()) }));
  });

  // The member must be visible before we will send to it — you cannot message
  // an oracle the broker has never heard of.
  const pub = mqtt.connect(`mqtt://127.0.0.1:${PORT}`);
  await new Promise((r) => pub.on("connect", r));
  pub.publish("oracle/alpha/lwt", "online", { qos: 1, retain: true });
  await Bun.sleep(300);

  const r = await fleet.sendToMember("alpha", "ping from the corpus", "main");
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.topic).toBe("oracle/alpha/main/in");

  const msg = await got;
  expect(msg.topic).toBe("oracle/alpha/main/in");
  expect(msg.body.text).toBe("ping from the corpus");
  expect(msg.body.user).toBe("test-memory");
  expect(typeof msg.body.id).toBe("string");

  sub.end(true);
  pub.end(true);
});

skip("a crafted name or room cannot escape its level in the topic tree", async () => {
  const fleet = await loadFleet();
  fleet.startFleet();
  await Bun.sleep(300);

  // Every one of these would change WHICH topic is published to if the segment
  // guard were missing — `#` and `+` are wildcards, `/` adds a level, and `..`
  // is the shape people reach for out of habit.
  for (const room of ["../#", "#", "+", "a/b", "", "x".repeat(65)]) {
    const r = await fleet.sendToMember("alpha", "x", room);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid room");
  }
  for (const name of ["#", "+", "a/b", "../etc"]) {
    const r = await fleet.sendToMember(name, "x", "main");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid name|no member named/);
  }
});

skip("replies arrive off <prefix>/<name>/<room>/out, depth-exact", async () => {
  const fleet = await loadFleet();
  fleet.startFleet();
  await Bun.sleep(300);

  const pub = mqtt.connect(`mqtt://127.0.0.1:${PORT}`);
  await new Promise((r) => pub.on("connect", r));

  pub.publish("oracle/alpha/main/out", JSON.stringify({ type: "msg", from: "assistant", text: "pong" }), { qos: 1 });
  // Deeper topic must NOT be read as a reply — depth-exact matching is what
  // stops an attachment or sub-channel being spoken aloud as a message.
  pub.publish("oracle/alpha/main/out/img", JSON.stringify({ text: "not a reply" }), { qos: 1 });
  await Bun.sleep(400);

  const got = fleet.memberReplies("alpha");
  expect(got.length).toBe(1);
  expect(got[0].text).toBe("pong");
  expect(got[0].room).toBe("main");

  pub.end(true);
});
