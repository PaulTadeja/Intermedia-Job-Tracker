#!/usr/bin/env node
/**
 * One-time (or re-runnable) seed script for the Intermedia Job Tracker.
 *
 * What it does:
 *   - Reads ../data/seed-data.json (598 tickets, 2 projects, meta, and the
 *     2 audit-log entries carried over from the old tool, exported at the
 *     moment this GitHub/Firebase version was built).
 *   - Writes meta/config as a single Firestore document.
 *   - Writes one document per project to the "projects" collection.
 *   - Writes one document per ticket to the "tickets" collection.
 *   - Writes one document per audit-log entry to the "auditLog" collection.
 *
 * Usage:
 *   1. cd scripts
 *   2. npm install
 *   3. Put your Firebase service account key JSON at scripts/serviceAccountKey.json
 *      (Firebase console → Project settings → Service accounts → Generate new private key)
 *   4. node seed.js
 *
 * Safety:
 *   - By default this REFUSES to run if meta/config already exists, so you
 *     can't accidentally double-seed or overwrite live data by re-running it.
 *   - Pass --force to overwrite anyway (e.g. if you're intentionally
 *     resetting to the original imported dataset).
 */

const fs = require("fs");
const path = require("path");

const SERVICE_ACCOUNT_PATH = path.join(__dirname, "serviceAccountKey.json");
const SEED_DATA_PATH = path.join(__dirname, "..", "data", "seed-data.json");
const FORCE = process.argv.includes("--force");

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)){
  console.error("\nMissing scripts/serviceAccountKey.json.");
  console.error("Get one from: Firebase console → Project settings → Service accounts → Generate new private key.");
  console.error("Save the downloaded file as scripts/serviceAccountKey.json (it's in .gitignore — never commit it).\n");
  process.exit(1);
}

if (!fs.existsSync(SEED_DATA_PATH)){
  console.error("\nMissing data/seed-data.json — it should already be in this project. Did you copy the whole folder?\n");
  process.exit(1);
}

const admin = require("firebase-admin");
const serviceAccount = require(SERVICE_ACCOUNT_PATH);
const seed = JSON.parse(fs.readFileSync(SEED_DATA_PATH, "utf8"));

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const BATCH_LIMIT = 450; // Firestore hard cap is 500 writes/batch; leave headroom

function chunk(arr, size){
  var out = [];
  for (var i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function commitInChunks(items, buildRef, buildData){
  var chunks = chunk(items, BATCH_LIMIT);
  for (var i = 0; i < chunks.length; i++){
    var batch = db.batch();
    chunks[i].forEach(function(item){
      batch.set(buildRef(item), buildData(item));
    });
    await batch.commit();
    console.log("  ...committed " + Math.min((i + 1) * BATCH_LIMIT, items.length) + " / " + items.length);
  }
}

async function main(){
  console.log("Intermedia Job Tracker — Firestore seed\n");

  var metaRef = db.collection("meta").doc("config");
  var existing = await metaRef.get();
  if (existing.exists && !FORCE){
    console.error("meta/config already exists in this Firestore project.");
    console.error("Refusing to overwrite live data. Re-run with --force if you really mean to reset everything back to the original imported dataset.\n");
    process.exit(1);
  }

  console.log("1/4 Writing meta/config...");
  await metaRef.set(seed.meta);

  console.log("2/4 Writing " + seed.projects.length + " project(s)...");
  await commitInChunks(
    seed.projects,
    function(p){ return db.collection("projects").doc(p.id); },
    function(p){ var d = Object.assign({}, p); delete d.id; return d; }
  );

  console.log("3/4 Writing " + seed.tickets.length + " ticket(s)...");
  await commitInChunks(
    seed.tickets,
    function(t){ return db.collection("tickets").doc(t.id); },
    function(t){ var d = Object.assign({}, t); delete d.id; return d; }
  );

  console.log("4/4 Writing " + seed.auditLog.length + " audit-log entr(y/ies)...");
  for (var i = 0; i < seed.auditLog.length; i++){
    var entry = seed.auditLog[i];
    await db.collection("auditLog").add({
      mode: entry.mode || "unknown",
      summary: entry.summary,
      ts: entry.ts ? admin.firestore.Timestamp.fromDate(new Date(entry.ts)) : admin.firestore.FieldValue.serverTimestamp()
    });
  }

  console.log("\nDone. Admin PIN: 5360   Tracking PIN: 2468");
  console.log("Change both from Admin mode → the lock menu the first time you open the live tracker.\n");
  process.exit(0);
}

main().catch(function(err){
  console.error("\nSeed failed:", err);
  process.exit(1);
});
