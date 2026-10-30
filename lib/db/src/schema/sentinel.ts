import {
  date,
  integer,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable(
  "sentinel_users",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: varchar("role", { length: 20 }).notNull().default("PUBLIC"),
    status: varchar("status", { length: 20 }).notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("sentinel_users_email_idx").on(table.email)],
);

export const missingPersonsTable = pgTable("sentinel_missing_persons", {
  id: serial("id").primaryKey(),
  fullName: varchar("full_name", { length: 160 }).notNull(),
  age: integer("age").notNull(),
  gender: varchar("gender", { length: 40 }).notNull(),
  height: varchar("height", { length: 40 }),
  description: text("description"),
  identificationMarks: text("identification_marks"),
  lastKnownLocation: varchar("last_known_location", { length: 180 }).notNull(),
  missingDate: date("missing_date", { mode: "string" }).notNull(),
  contactInformation: text("contact_information"),
  additionalInformation: text("additional_information"),
  status: varchar("status", { length: 40 }).notNull().default("Missing"),
  imageUrl: text("image_url"),
  archived: text("archived").notNull().default("false"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const personImagesTable = pgTable("sentinel_person_images", {
  id: serial("id").primaryKey(),
  missingPersonId: integer("missing_person_id").notNull(),
  imageUrl: text("image_url").notNull(),
  embedding: text("embedding"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sightingsTable = pgTable("sentinel_sightings", {
  id: serial("id").primaryKey(),
  missingPersonId: integer("missing_person_id"),
  imageUrl: text("image_url"),
  location: varchar("location", { length: 180 }).notNull(),
  sightingDate: timestamp("sighting_date", { withTimezone: true }).notNull(),
  description: text("description").notNull(),
  reporterName: varchar("reporter_name", { length: 120 }),
  reporterContact: varchar("reporter_contact", { length: 180 }),
  status: varchar("status", { length: 40 }).notNull().default("New"),
  topMatchScore: real("top_match_score"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const matchHistoryTable = pgTable("sentinel_match_history", {
  id: serial("id").primaryKey(),
  sightingId: integer("sighting_id"),
  matchedPersonId: integer("matched_person_id").notNull(),
  confidenceScore: real("confidence_score").notNull(),
  ranking: integer("ranking").notNull(),
  reviewStatus: varchar("review_status", { length: 30 }).notNull().default("Pending"),
  reviewedBy: integer("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alertsTable = pgTable("sentinel_alerts", {
  id: serial("id").primaryKey(),
  missingPersonId: integer("missing_person_id").notNull(),
  sightingId: integer("sighting_id"),
  confidenceScore: real("confidence_score").notNull(),
  status: varchar("status", { length: 30 }).notNull().default("New"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogsTable = pgTable("sentinel_audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id"),
  action: varchar("action", { length: 80 }).notNull(),
  entity: varchar("entity", { length: 80 }).notNull(),
  entityId: integer("entity_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cctvEvidenceTable = pgTable("sentinel_cctv_evidence", {
  id: serial("id").primaryKey(),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  fileType: varchar("file_type", { length: 80 }).notNull(),
  filePath: text("file_path").notNull(),
  mediaType: varchar("media_type", { length: 20 }).notNull().default("video"),
  cameraName: varchar("camera_name", { length: 160 }),
  cameraId: varchar("camera_id", { length: 80 }),
  location: varchar("location", { length: 180 }),
  recordingDate: date("recording_date", { mode: "string" }),
  recordingTime: varchar("recording_time", { length: 40 }),
  description: text("description"),
  durationSeconds: real("duration_seconds"),
  fps: real("fps"),
  width: integer("width"),
  height: integer("height"),
  frameInterval: real("frame_interval").notNull().default(1),
  uploadedBy: integer("uploaded_by"),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  processingStatus: varchar("processing_status", { length: 40 }).notNull().default("Uploaded"),
  errorMessage: text("error_message"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  archived: text("archived").notNull().default("false"),
});

export const cctvTracksTable = pgTable("sentinel_cctv_tracks", {
  id: serial("id").primaryKey(),
  evidenceId: integer("evidence_id").notNull(),
  trackNumber: integer("track_number").notNull(),
  firstTimestamp: real("first_timestamp").notNull(),
  lastTimestamp: real("last_timestamp").notNull(),
  frameCount: integer("frame_count").notNull(),
  bestFramePath: text("best_frame_path"),
  bestMatchPersonId: integer("best_match_person_id"),
  bestMatchScore: real("best_match_score"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cctvMatchesTable = pgTable("sentinel_cctv_matches", {
  id: serial("id").primaryKey(),
  evidenceId: integer("evidence_id").notNull(),
  trackId: integer("track_id"),
  matchedPersonId: integer("matched_person_id"),
  cctvFramePath: text("cctv_frame_path"),
  confidenceScore: real("confidence_score"),
  timestampSeconds: real("timestamp_seconds"),
  reviewStatus: varchar("review_status", { length: 40 }).notNull().default("Pending"),
  reviewedBy: integer("reviewed_by"),
  notes: text("notes"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
});
export const insertMissingPersonSchema = createInsertSchema(missingPersonsTable).omit({
  id: true,
  archived: true,
  createdAt: true,
  updatedAt: true,
});
export const insertPersonImageSchema = createInsertSchema(personImagesTable).omit({
  id: true,
  createdAt: true,
});
export const insertSightingSchema = createInsertSchema(sightingsTable).omit({
  id: true,
  createdAt: true,
});
export const insertMatchHistorySchema = createInsertSchema(matchHistoryTable).omit({
  id: true,
  createdAt: true,
});
export const insertAlertSchema = createInsertSchema(alertsTable).omit({
  id: true,
  createdAt: true,
});
export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({
  id: true,
  createdAt: true,
});
export const insertCctvEvidenceSchema = createInsertSchema(cctvEvidenceTable).omit({
  id: true,
  uploadedAt: true,
  processingStatus: true,
  completedAt: true,
});
export const insertCctvTrackSchema = createInsertSchema(cctvTracksTable).omit({
  id: true,
  createdAt: true,
});
export const insertCctvMatchSchema = createInsertSchema(cctvMatchesTable).omit({
  id: true,
  createdAt: true,
});

export type User = typeof usersTable.$inferSelect;
export type MissingPerson = typeof missingPersonsTable.$inferSelect;
export type PersonImage = typeof personImagesTable.$inferSelect;
export type Sighting = typeof sightingsTable.$inferSelect;
export type MatchHistory = typeof matchHistoryTable.$inferSelect;
export type Alert = typeof alertsTable.$inferSelect;
export type CctvEvidence = typeof cctvEvidenceTable.$inferSelect;
export type CctvTrack = typeof cctvTracksTable.$inferSelect;
export type CctvMatch = typeof cctvMatchesTable.$inferSelect;