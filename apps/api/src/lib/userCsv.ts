// ─────────────────────────────────────────────────────────────────────
//  User CSV export / import helpers (RFC 4180-ish).
//
//  devices column format (semicolon-separated entries):
//    mac|label|status
//  Example:
//    aa:bb:cc:dd:ee:ff|iPhone|approved;11:22:33:44:55:66|Laptop|pending
//  Prefix MAC with * to mark primary: *aa:bb:cc:dd:ee:ff|Phone|approved
//  label may be empty: aa:bb:cc:dd:ee:ff||approved
// ─────────────────────────────────────────────────────────────────────

export const USER_CSV_HEADERS = [
  "username",
  "email",
  "phone",
  "fullName",
  "password",
  "role",
  "status",
  "group",
  "certEnabled",
  "validFrom",
  "validUntil",
  "devices",
] as const;

export type UserCsvHeader = (typeof USER_CSV_HEADERS)[number];

export type DeviceCsvStatus = "pending" | "approved" | "rejected" | "blocked";

export interface ParsedDeviceEntry {
  macRaw: string;
  label: string | null;
  status: DeviceCsvStatus;
  isPrimary: boolean;
}

export interface UserCsvRow {
  username: string;
  email: string;
  phone: string;
  fullName: string;
  password: string;
  role: string;
  status: string;
  group: string;
  certEnabled: string;
  validFrom: string;
  validUntil: string;
  devices: string;
  /** True when the CSV header included a devices column. */
  hasDevicesColumn: boolean;
  /** 1-based line number in the source CSV (header = 1). */
  line: number;
}

function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(rows: Array<Record<UserCsvHeader, string>>): string {
  const lines = [
    USER_CSV_HEADERS.join(","),
    ...rows.map((row) => USER_CSV_HEADERS.map((h) => escapeCsvField(row[h] ?? "")).join(",")),
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** Parse one CSV line respecting quoted fields. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

export function formatDevicesForCsv(
  devices: Array<{ mac: string; label: string | null; status: string; isPrimary?: boolean }>,
): string {
  return devices
    .map((d) => {
      const mac = d.isPrimary ? `*${d.mac}` : d.mac;
      const label = (d.label ?? "").replace(/[|;]/g, " ");
      return `${mac}|${label}|${d.status}`;
    })
    .join(";");
}

export function parseDevicesField(value: string): { entries: ParsedDeviceEntry[]; error?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { entries: [] };

  const entries: ParsedDeviceEntry[] = [];
  const parts = trimmed.split(";").map((p) => p.trim()).filter(Boolean);

  for (const part of parts) {
    const bits = part.split("|").map((b) => b.trim());
    if (bits.length < 1 || !bits[0]) {
      return { entries: [], error: `invalid device entry "${part}" (expected mac|label|status)` };
    }
    let macRaw = bits[0]!;
    let isPrimary = false;
    if (macRaw.startsWith("*")) {
      isPrimary = true;
      macRaw = macRaw.slice(1).trim();
    }
    const label = bits[1]?.trim() ? bits[1]!.trim().slice(0, 80) : null;
    const statusRaw = (bits[2] || "approved").toLowerCase();
    const allowed: DeviceCsvStatus[] = ["pending", "approved", "rejected", "blocked"];
    if (!allowed.includes(statusRaw as DeviceCsvStatus)) {
      return {
        entries: [],
        error: `invalid device status "${bits[2]}" (use pending|approved|rejected|blocked)`,
      };
    }
    entries.push({
      macRaw,
      label,
      status: statusRaw as DeviceCsvStatus,
      isPrimary,
    });
  }

  if (!entries.some((e) => e.isPrimary) && entries.length > 0) {
    entries[0]!.isPrimary = true;
  }

  return { entries };
}

export function parseUserCsv(text: string): { rows: UserCsvRow[]; errors: string[] } {
  const errors: string[] = [];
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = normalized.split("\n");
  while (rawLines.length && rawLines[rawLines.length - 1]!.trim() === "") rawLines.pop();
  if (rawLines.length === 0) {
    return { rows: [], errors: ["CSV is empty"] };
  }

  const headerFields = parseCsvLine(rawLines[0]!).map((h) => h.trim().toLowerCase());
  const indexOf: Partial<Record<UserCsvHeader, number>> = {};
  for (const h of USER_CSV_HEADERS) {
    const idx = headerFields.indexOf(h.toLowerCase());
    if (idx >= 0) indexOf[h] = idx;
  }

  if (indexOf.username === undefined) {
    return {
      rows: [],
      errors: ["CSV header must include a username column"],
    };
  }

  const hasDevicesColumn = indexOf.devices !== undefined;
  const rows: UserCsvRow[] = [];
  for (let i = 1; i < rawLines.length; i++) {
    const lineText = rawLines[i]!;
    if (!lineText.trim()) continue;
    const fields = parseCsvLine(lineText);
    const get = (h: UserCsvHeader) => {
      const idx = indexOf[h];
      return idx === undefined ? "" : (fields[idx] ?? "").trim();
    };
    rows.push({
      username: get("username"),
      email: get("email"),
      phone: get("phone"),
      fullName: get("fullName"),
      password: get("password"),
      role: get("role"),
      status: get("status"),
      group: get("group"),
      certEnabled: get("certEnabled"),
      validFrom: get("validFrom"),
      validUntil: get("validUntil"),
      devices: get("devices"),
      hasDevicesColumn,
      line: i + 1,
    });
  }

  return { rows, errors };
}

export function parseBool(value: string, fallback = true): boolean {
  if (!value.trim()) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return fallback;
}

export function parseOptionalIsoDate(value: string): string | null | undefined {
  if (!value.trim()) return null;
  const d = new Date(value.trim());
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export const USER_CSV_TEMPLATE = toCsv([
  {
    username: "jdoe",
    email: "jdoe@example.com",
    phone: "+8801700000000",
    fullName: "Jane Doe",
    password: "ChangeMe123!",
    role: "user",
    status: "active",
    group: "Guest",
    certEnabled: "true",
    validFrom: "",
    validUntil: "",
    devices: "*aa:bb:cc:dd:ee:ff|iPhone|approved;11:22:33:44:55:66|Laptop|approved",
  },
]);
