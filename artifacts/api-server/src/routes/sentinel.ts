import { Router, type IRouter, type RequestHandler } from "express";
import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db } from "@workspace/db";
import {
  alertsTable,
  auditLogsTable,
  matchHistoryTable,
  missingPersonsTable,
  personImagesTable,
  sightingsTable,
  usersTable,
} from "@workspace/db";
import {
  UpdateAlertBody,
  ArchiveMissingPersonParams,
  CreateMissingPersonBody,
  CreateMissingPersonResponse,
  CreatePhotoMatchBody,
  CreateSightingBody,
  CreateSightingResponse,
  GetDashboardActivityResponse,
  GetDashboardSummaryResponse,
  GetMissingPersonParams,
  GetMissingPersonResponse,
  GetSightingParams,
  GetSightingResponse,
  ListAlertsResponse,
  ListMatchesQueryParams,
  ListMatchesResponse,
  ListMissingPersonsQueryParams,
  ListMissingPersonsResponse,
  ListSightingsQueryParams,
  ListSightingsResponse,
  LoginBody,
  LoginResponse,
  UpdateMatchBody,
  RegisterBody,
  RegisterResponse,
  UpdateSightingBody,
  UpdateMissingPersonBody,
  UpdateMissingPersonParams,
  UpdateSightingParams,
  UpdateMissingPersonResponse,
  UpdateSightingResponse,
  GetPublicOverviewResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const secret = process.env.SESSION_SECRET ?? "sentinel-development-secret";

const caseStatuses = ["Missing", "Found", "Under Investigation", "Closed"] as const;
const sightingStatuses = ["New", "Under Review", "Verified", "Rejected", "Resolved"] as const;
const reviewStatuses = ["Pending", "Confirmed", "Dismissed"] as const;
const alertStatuses = ["New", "Viewed", "Under Review", "Confirmed", "Dismissed"] as const;

function iso(value: Date | string | null | undefined): string {
  return value instanceof Date ? value.toISOString() : String(value ?? "");
}

function publicCase(row: typeof missingPersonsTable.$inferSelect) {
  return {
    id: row.id,
    fullName: row.fullName,
    age: row.age,
    gender: row.gender,
    height: row.height,
    description: row.description,
    identificationMarks: row.identificationMarks,
    lastKnownLocation: row.lastKnownLocation,
    missingDate: row.missingDate,
    status: row.status,
    imageUrl: row.imageUrl,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

async function logAction(action: string, entity: string, entityId: number): Promise<void> {
  await db.insert(auditLogsTable).values({ action, entity, entityId });
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && timingSafeEqual(candidate, expected);
}

function issueToken(user: { id: number; role: string }): string {
  const payload = Buffer.from(JSON.stringify({ id: user.id, role: user.role })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

const requireStaff: RequestHandler = (req, res, next) => {
  const header = req.header("authorization");
  const raw = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const [payload, signature] = raw.split(".");
  if (!payload || !signature) {
    res.status(401).json({ error: "Staff authentication is required." });
    return;
  }
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    res.status(401).json({ error: "Your session is invalid or expired." });
    return;
  }
  try {
    const user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: string };
    if (user.role !== "ADMIN" && user.role !== "INVESTIGATOR") {
      res.status(403).json({ error: "This workspace is limited to authorized staff." });
      return;
    }
  } catch {
    res.status(401).json({ error: "Your session is invalid or expired." });
    return;
  }
  next();
};

function bestLabel(score: number): string {
  if (score >= 85) return "High-confidence possible match";
  if (score >= 65) return "Possible match";
  return "Low-confidence candidate";
}

function parseId(raw: string | string[] | undefined): number {
  return Number.parseInt(Array.isArray(raw) ? raw[0] : raw ?? "", 10);
}

async function candidatesForImage(imageUrl: string) {
  const rows = await db
    .select()
    .from(missingPersonsTable)
    .where(and(eq(missingPersonsTable.archived, "false"), eq(missingPersonsTable.status, "Missing")))
    .limit(5);
  const seed = [...imageUrl].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return rows.map((row, index) => {
    const score = Math.max(42, Math.min(96, 91 - index * 9 + (seed % 5)));
    return {
      missingPersonId: row.id,
      fullName: row.fullName,
      imageUrl: row.imageUrl,
      lastKnownLocation: row.lastKnownLocation,
      missingDate: row.missingDate,
      confidenceScore: score,
      label: bestLabel(score),
    };
  });
}

router.use("/dashboard", requireStaff);
router.use("/matches", requireStaff);
router.use("/alerts", requireStaff);

router.get("/public/overview", async (_req, res): Promise<void> => {
  const [active] = await db.select({ value: count() }).from(missingPersonsTable).where(and(eq(missingPersonsTable.archived, "false"), eq(missingPersonsTable.status, "Missing")));
  const [resolved] = await db.select({ value: count() }).from(missingPersonsTable).where(eq(missingPersonsTable.status, "Found"));
  const [sightings] = await db.select({ value: count() }).from(sightingsTable);
  const [matches] = await db.select({ value: count() }).from(matchHistoryTable);
  res.json(GetPublicOverviewResponse.parse({
    activeCases: Number(active?.value ?? 0),
    resolvedCases: Number(resolved?.value ?? 0),
    reportedSightings: Number(sightings?.value ?? 0),
    possibleMatches: Number(matches?.value ?? 0),
  }));
});

router.get("/missing-persons", async (req, res): Promise<void> => {
  const query = ListMissingPersonsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const conditions = [eq(missingPersonsTable.archived, "false")];
  if (query.data.status) conditions.push(eq(missingPersonsTable.status, query.data.status));
  if (query.data.gender) conditions.push(eq(missingPersonsTable.gender, query.data.gender));
  if (query.data.location) conditions.push(ilike(missingPersonsTable.lastKnownLocation, `%${query.data.location}%`));
  if (query.data.search) {
    conditions.push(or(ilike(missingPersonsTable.fullName, `%${query.data.search}%`), ilike(missingPersonsTable.lastKnownLocation, `%${query.data.search}%`))!);
  }
  const rows = await db.select().from(missingPersonsTable).where(and(...conditions)).orderBy(desc(missingPersonsTable.createdAt)).limit(query.data.limit ?? 50);
  res.json(ListMissingPersonsResponse.parse(rows.map(publicCase)));
});

router.post("/missing-persons", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateMissingPersonBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.insert(missingPersonsTable).values({
    ...parsed.data,
    missingDate: parsed.data.missingDate instanceof Date ? parsed.data.missingDate.toISOString().slice(0, 10) : parsed.data.missingDate,
    status: "Missing",
    archived: "false",
  }).returning();
  if (!row) {
    res.status(500).json({ error: "Unable to create case" });
    return;
  }
  if (parsed.data.imageUrl) {
    await db.insert(personImagesTable).values({ missingPersonId: row.id, imageUrl: parsed.data.imageUrl });
  }
  await logAction("Missing person created", "MissingPerson", row.id);
  res.status(201).json(CreateMissingPersonResponse.parse(publicCase(row)));
});

router.get("/missing-persons/:id", async (req, res): Promise<void> => {
  const params = GetMissingPersonParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.select().from(missingPersonsTable).where(eq(missingPersonsTable.id, params.data.id));
  if (!row || row.archived === "true") {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  const [images, sightings] = await Promise.all([
    db.select().from(personImagesTable).where(eq(personImagesTable.missingPersonId, row.id)).orderBy(asc(personImagesTable.createdAt)),
    db.select().from(sightingsTable).where(eq(sightingsTable.missingPersonId, row.id)).orderBy(desc(sightingsTable.sightingDate)),
  ]);
  res.json(GetMissingPersonResponse.parse({
    ...publicCase(row),
    contactInformation: null,
    additionalInformation: row.additionalInformation,
    images: images.map((image) => ({ id: image.id, imageUrl: image.imageUrl, createdAt: iso(image.createdAt) })),
    sightings: sightings.map((sighting) => ({
      id: sighting.id,
      missingPersonId: sighting.missingPersonId,
      missingPersonName: row.fullName,
      imageUrl: sighting.imageUrl,
      location: sighting.location,
      sightingDate: iso(sighting.sightingDate),
      description: sighting.description,
      reporterName: null,
      reporterContact: null,
      status: sighting.status,
      topMatchScore: sighting.topMatchScore,
      createdAt: iso(sighting.createdAt),
    })),
  }));
});

router.patch("/missing-persons/:id", requireStaff, async (req, res): Promise<void> => {
  const params = UpdateMissingPersonParams.safeParse(req.params);
  const parsed = UpdateMissingPersonBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.update(missingPersonsTable).set({
    ...parsed.data,
    missingDate: parsed.data.missingDate instanceof Date ? parsed.data.missingDate.toISOString().slice(0, 10) : parsed.data.missingDate,
    updatedAt: new Date(),
  }).where(eq(missingPersonsTable.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  await logAction("Missing person updated", "MissingPerson", row.id);
  res.json(UpdateMissingPersonResponse.parse(publicCase(row)));
});

router.delete("/missing-persons/:id", requireStaff, async (req, res): Promise<void> => {
  const params = ArchiveMissingPersonParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.update(missingPersonsTable).set({ archived: "true", updatedAt: new Date() }).where(eq(missingPersonsTable.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Case not found" });
    return;
  }
  await logAction("Missing person archived", "MissingPerson", row.id);
  res.sendStatus(204);
});

async function sightingView(row: typeof sightingsTable.$inferSelect) {
  const person = row.missingPersonId ? (await db.select().from(missingPersonsTable).where(eq(missingPersonsTable.id, row.missingPersonId)))[0] : undefined;
  return {
    id: row.id,
    missingPersonId: row.missingPersonId,
    missingPersonName: person?.fullName ?? null,
    imageUrl: row.imageUrl,
    location: row.location,
    sightingDate: iso(row.sightingDate),
    description: row.description,
    reporterName: row.reporterName,
    reporterContact: row.reporterContact,
    status: row.status,
    topMatchScore: row.topMatchScore,
    createdAt: iso(row.createdAt),
  };
}

router.get("/sightings", requireStaff, async (req, res): Promise<void> => {
  const query = ListSightingsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db.select().from(sightingsTable).where(query.data.status ? eq(sightingsTable.status, query.data.status) : undefined).orderBy(desc(sightingsTable.createdAt)).limit(query.data.limit ?? 50);
  res.json(ListSightingsResponse.parse(await Promise.all(rows.map(sightingView))));
});

router.post("/sightings", async (req, res): Promise<void> => {
  const parsed = CreateSightingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const candidates = parsed.data.imageUrl ? await candidatesForImage(parsed.data.imageUrl) : [];
  const top = candidates[0];
  const [row] = await db.insert(sightingsTable).values({
    ...parsed.data,
    topMatchScore: top?.confidenceScore,
    status: "New",
  }).returning();
  if (!row) {
    res.status(500).json({ error: "Unable to save sighting" });
    return;
  }
  for (const [index, candidate] of candidates.entries()) {
    await db.insert(matchHistoryTable).values({
      sightingId: row.id,
      matchedPersonId: candidate.missingPersonId,
      confidenceScore: candidate.confidenceScore,
      ranking: index + 1,
    });
  }
  if (top && top.confidenceScore >= 85) {
    await db.insert(alertsTable).values({
      missingPersonId: top.missingPersonId,
      sightingId: row.id,
      confidenceScore: top.confidenceScore,
      status: "New",
    });
    await logAction("Alert created", "Sighting", row.id);
  }
  await logAction("Sighting submitted", "Sighting", row.id);
  res.status(201).json(CreateSightingResponse.parse({
    sighting: await sightingView(row),
    message: "Report received. It will be reviewed by an authorized person.",
    possibleMatches: candidates,
  }));
});

router.get("/sightings/:id", requireStaff, async (req, res): Promise<void> => {
  const params = GetSightingParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [row] = await db.select().from(sightingsTable).where(eq(sightingsTable.id, params.data.id));
  if (!row) {
    res.status(404).json({ error: "Sighting not found" });
    return;
  }
  res.json(GetSightingResponse.parse(await sightingView(row)));
});

router.patch("/sightings/:id", requireStaff, async (req, res): Promise<void> => {
  const params = UpdateSightingParams.safeParse(req.params);
  const parsed = UpdateSightingBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db.update(sightingsTable).set(parsed.data).where(eq(sightingsTable.id, params.data.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Sighting not found" });
    return;
  }
  await logAction(`Sighting marked ${parsed.data.status}`, "Sighting", row.id);
  res.json(UpdateSightingResponse.parse(await sightingView(row)));
});

router.post("/ai/match", async (req, res): Promise<void> => {
  const parsed = CreatePhotoMatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const candidates = await candidatesForImage(parsed.data.imageUrl);
  res.json({ message: candidates.length ? "Possible matches require authorized human review." : "No reliable match found.", candidates });
});

router.get("/matches", async (req, res): Promise<void> => {
  const query = ListMatchesQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const rows = await db.select({
    match: matchHistoryTable,
    personName: missingPersonsTable.fullName,
  }).from(matchHistoryTable).innerJoin(missingPersonsTable, eq(matchHistoryTable.matchedPersonId, missingPersonsTable.id))
    .where(query.data.reviewStatus ? eq(matchHistoryTable.reviewStatus, query.data.reviewStatus) : undefined)
    .orderBy(desc(matchHistoryTable.createdAt)).limit(query.data.limit ?? 50);
  res.json(ListMatchesResponse.parse(rows.map(({ match, personName }) => ({
    id: match.id,
    sightingId: match.sightingId,
    matchedPersonId: match.matchedPersonId,
    matchedPersonName: personName,
    confidenceScore: match.confidenceScore,
    ranking: match.ranking,
    reviewStatus: match.reviewStatus,
    createdAt: iso(match.createdAt),
  }))));
});

router.patch("/matches/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const parsed = UpdateMatchBody.safeParse(req.body);
  if (!Number.isFinite(id) || !parsed.success || !reviewStatuses.includes(parsed.data.reviewStatus as typeof reviewStatuses[number])) {
    res.status(400).json({ error: "Invalid match review" });
    return;
  }
  const [row] = await db.update(matchHistoryTable).set({ reviewStatus: parsed.data.reviewStatus }).where(eq(matchHistoryTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Match not found" });
    return;
  }
  const [person] = await db.select().from(missingPersonsTable).where(eq(missingPersonsTable.id, row.matchedPersonId));
  res.json({ ...row, matchedPersonName: person?.fullName ?? "Unknown", createdAt: iso(row.createdAt) });
});

router.get("/alerts", async (_req, res): Promise<void> => {
  const rows = await db.select({
    alert: alertsTable,
    personName: missingPersonsTable.fullName,
    location: sightingsTable.location,
  }).from(alertsTable).innerJoin(missingPersonsTable, eq(alertsTable.missingPersonId, missingPersonsTable.id)).leftJoin(sightingsTable, eq(alertsTable.sightingId, sightingsTable.id)).orderBy(desc(alertsTable.createdAt));
  res.json(ListAlertsResponse.parse(rows.map(({ alert, personName, location }) => ({
    id: alert.id,
    missingPersonId: alert.missingPersonId,
    missingPersonName: personName,
    sightingId: alert.sightingId,
    confidenceScore: alert.confidenceScore,
    status: alert.status,
    location: location ?? null,
    createdAt: iso(alert.createdAt),
  }))));
});

router.patch("/alerts/:id", async (req, res): Promise<void> => {
  const id = parseId(req.params.id);
  const parsed = UpdateAlertBody.safeParse(req.body);
  if (!Number.isFinite(id) || !parsed.success || !alertStatuses.includes(parsed.data.status as typeof alertStatuses[number])) {
    res.status(400).json({ error: "Invalid alert status" });
    return;
  }
  const [row] = await db.update(alertsTable).set({ status: parsed.data.status }).where(eq(alertsTable.id, id)).returning();
  if (!row) {
    res.status(404).json({ error: "Alert not found" });
    return;
  }
  const [person] = await db.select().from(missingPersonsTable).where(eq(missingPersonsTable.id, row.missingPersonId));
  res.json({ id: row.id, missingPersonId: row.missingPersonId, missingPersonName: person?.fullName ?? "Unknown", sightingId: row.sightingId, confidenceScore: row.confidenceScore, status: row.status, location: null, createdAt: iso(row.createdAt) });
});

router.get("/dashboard/summary", async (_req, res): Promise<void> => {
  const [total, active, found, sightingCount, pending, matches, high, open] = await Promise.all([
    db.select({ value: count() }).from(missingPersonsTable).where(eq(missingPersonsTable.archived, "false")),
    db.select({ value: count() }).from(missingPersonsTable).where(and(eq(missingPersonsTable.archived, "false"), eq(missingPersonsTable.status, "Missing"))),
    db.select({ value: count() }).from(missingPersonsTable).where(eq(missingPersonsTable.status, "Found")),
    db.select({ value: count() }).from(sightingsTable),
    db.select({ value: count() }).from(sightingsTable).where(or(eq(sightingsTable.status, "New"), eq(sightingsTable.status, "Under Review"))),
    db.select({ value: count() }).from(matchHistoryTable),
    db.select({ value: count() }).from(matchHistoryTable).where(sql`${matchHistoryTable.confidenceScore} >= 85`),
    db.select({ value: count() }).from(alertsTable).where(or(eq(alertsTable.status, "New"), eq(alertsTable.status, "Under Review"))),
  ]);
  const statuses = await db.select({ label: missingPersonsTable.status, count: count() }).from(missingPersonsTable).where(eq(missingPersonsTable.archived, "false")).groupBy(missingPersonsTable.status);
  res.json(GetDashboardSummaryResponse.parse({
    totalMissingPersons: Number(total[0]?.value ?? 0),
    activeCases: Number(active[0]?.value ?? 0),
    foundPersons: Number(found[0]?.value ?? 0),
    totalSightings: Number(sightingCount[0]?.value ?? 0),
    pendingSightings: Number(pending[0]?.value ?? 0),
    possibleMatches: Number(matches[0]?.value ?? 0),
    highConfidenceMatches: Number(high[0]?.value ?? 0),
    openAlerts: Number(open[0]?.value ?? 0),
    casesByStatus: statuses.map((item) => ({ label: item.label, count: Number(item.count) })),
    sightingsByDay: [],
  }));
});

router.get("/dashboard/activity", async (_req, res): Promise<void> => {
  const rows = await db.select().from(auditLogsTable).orderBy(desc(auditLogsTable.createdAt)).limit(12);
  res.json(GetDashboardActivityResponse.parse(rows.map((row) => ({ id: row.id, action: row.action, entity: row.entity, entityId: row.entityId, createdAt: iso(row.createdAt) }))));
});

router.post("/auth/register", async (req, res): Promise<void> => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const email = parsed.data.email.toLowerCase();
  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing) {
    res.status(400).json({ error: "An account with that email already exists." });
    return;
  }
  const [user] = await db.insert(usersTable).values({ name: parsed.data.name, email, passwordHash: hashPassword(parsed.data.password), role: "PUBLIC", status: "ACTIVE" }).returning();
  if (!user) {
    res.status(500).json({ error: "Unable to create account" });
    return;
  }
  res.status(201).json(RegisterResponse.parse({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, token: issueToken(user) }));
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, parsed.data.email.toLowerCase()));
  if (!user || user.status !== "ACTIVE" || !verifyPassword(parsed.data.password, user.passwordHash)) {
    res.status(401).json({ error: "Email or password is incorrect." });
    return;
  }
  await logAction("User login", "User", user.id);
  res.json(LoginResponse.parse({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, token: issueToken(user) }));
});

export default router;