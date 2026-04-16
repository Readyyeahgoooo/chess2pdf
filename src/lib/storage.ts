import { openDB, type DBSchema } from "idb";
import type { PdfSession } from "@/lib/types";

interface Chess2PdfDb extends DBSchema {
  sessions: {
    key: string;
    value: PdfSession;
    indexes: { "by-created": string };
  };
}

const DB_NAME = "chess2pdf";
const DB_VERSION = 1;
const MAX_STUDIES = 10;

async function getDb() {
  return openDB<Chess2PdfDb>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore("sessions", { keyPath: "id" });
      store.createIndex("by-created", "createdAt");
    },
  });
}

export async function saveSession(session: PdfSession): Promise<void> {
  const db = await getDb();
  await db.put("sessions", session);
  const sessions = await listSessions();
  await Promise.all(sessions.slice(MAX_STUDIES).map((oldSession) => db.delete("sessions", oldSession.id)));
}

export async function listSessions(): Promise<PdfSession[]> {
  const db = await getDb();
  const sessions = await db.getAllFromIndex("sessions", "by-created");
  return sessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_STUDIES);
}

export async function deleteSession(id: string): Promise<void> {
  const db = await getDb();
  await db.delete("sessions", id);
}

export async function clearLocalData(): Promise<void> {
  const db = await getDb();
  await db.clear("sessions");
}
