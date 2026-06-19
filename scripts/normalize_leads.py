#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import openpyxl

DATA_DIR = Path("data")
OUT_FILE = DATA_DIR / "normalized-leads.csv"
DUPES_FILE = DATA_DIR / "duplicates-review.csv"
REJECTED_FILE = DATA_DIR / "rejected-rows.csv"
SUMMARY_FILE = DATA_DIR / "normalized-summary.json"

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

OUTPUT_COLUMNS = [
    "email",
    "firstName",
    "lastName",
    "name",
    "title",
    "company",
    "industry",
    "website",
    "linkedin",
    "source",
    "niche",
    "subNiche",
    "location",
    "city",
    "state",
    "country",
    "employees",
    "emailStatus",
    "keywords",
    "companyLinkedin",
    "companyFacebook",
    "companyTwitter",
    "companyPhone",
    "alternateEmails",
    "apolloId",
    "sourceFile",
    "sourceSheet",
    "notes",
]

HEADER_MAP = {
    "apollo id": "apolloId",
    "linkedin url": "linkedin",
    "linkedin_url": "linkedin",
    "linkedinurl": "linkedin",
    "full name": "name",
    "full_name": "name",
    "fullname": "name",
    "lead name": "name",
    "first name": "firstName",
    "first_name": "firstName",
    "firstname": "firstName",
    "last name": "lastName",
    "last_name": "lastName",
    "lastname": "lastName",
    "email": "email",
    "all emails": "alternateEmails",
    "all_emails": "alternateEmails",
    "email status": "emailStatus",
    "email_status": "emailStatus",
    "title": "title",
    "position": "title",
    "job title": "title",
    "job_title": "title",
    "role": "title",
    "company": "company",
    "organizationname": "company",
    "organization name": "company",
    "company name": "company",
    "company_name": "company",
    "buisness name": "company",
    "business name": "company",
    "website": "website",
    "organizationwebsite": "website",
    "organization website": "website",
    "company website": "website",
    "company_website": "website",
    "city": "city",
    "state": "state",
    "country": "country",
    "industry": "industry",
    "organizationindustry": "industry",
    "organization industry": "industry",
    "keywords": "keywords",
    "organizationspecialities": "keywords",
    "organization specialities": "keywords",
    "employees": "employees",
    "organizationsize": "employees",
    "organization size": "employees",
    "# of employees": "employees",
    "company city": "companyCity",
    "company_city": "companyCity",
    "company state": "companyState",
    "company_state": "companyState",
    "company country": "companyCountry",
    "company_country": "companyCountry",
    "company linkedin url": "companyLinkedin",
    "company_linkedin_url": "companyLinkedin",
    "linkedin": "linkedin",
    "organizationlinkedinurl": "companyLinkedin",
    "organization linkedin url": "companyLinkedin",
    "company twitter url": "companyTwitter",
    "company_twitter_url": "companyTwitter",
    "company facebook url": "companyFacebook",
    "company phone numbers": "companyPhone",
    "phone numbers": "companyPhone",
    "phone_numbers": "companyPhone",
    "twitter url": "twitter",
    "facebook url": "facebook",
    "niche": "niche",
    "subniche": "subNiche",
    "sub niche": "subNiche",
    "special notes": "notes",
    "notes": "notes",
    "organizationdescription": "notes",
    "organization description": "notes",
    "painpoint": "notes",
    "link": "sourceLink",
    "source": "source",
}

SUBNICHE_RULES = [
    ("HVAC", ["hvac", "heating", "cooling", "air conditioning", "furnace"]),
    ("Paving / Asphalt", ["paving", "asphalt", "pave", "sealcoat", "striping"]),
    ("Roofing", ["roof", "roofing", "shingle", "gutters"]),
    ("Remodeling / Renovation", ["remodel", "renovation", "home improvement", "kitchen", "bathroom"]),
    ("General Contractor", ["general contractor", "contractor", "construction management", "builder"]),
    ("Fire / Safety", ["fire protection", "fire alarm", "safety", "osha"]),
    ("Electrical / Security", ["electrical", "electrician", "security", "alarm"]),
    ("Real Estate Agent / Team", ["real estate agent", "home buying", "home selling", "realtor"]),
    ("Property / Renovation Investment", ["property management", "investment", "renovation loans", "hud"]),
    ("Family / Mediation Law", ["family law", "divorce", "mediation", "custody"]),
    ("Personal Injury Law", ["personal injury", "car accidents", "wrongful death", "injury"]),
    ("Construction Law", ["construction law", "contract disputes", "mechanics lien"]),
    ("Medical Billing / RCM", ["revenue cycle", "medical billing", "coding", "claims"]),
    ("Medical Devices / Diagnostics", ["medical devices", "diagnostic", "clinical", "fda"]),
    ("Insurance", ["insurance", "risk management", "coverage", "claims"]),
    ("Financial Planning", ["financial planning", "wealth", "retirement", "investment"]),
    ("Travel Agency", ["travel", "vacation", "tourism"]),
]


@dataclass
class SourceRow:
    normalized: dict[str, str]
    raw: dict[str, str]


@dataclass
class MergedLead:
    row: dict[str, str]
    sources: list[str] = field(default_factory=list)
    duplicateCount: int = 0


def main() -> None:
    rows: list[SourceRow] = []
    rejected: list[dict[str, str]] = []

    for path in sorted(DATA_DIR.glob("*.csv")):
        if path.name in {OUT_FILE.name, DUPES_FILE.name, REJECTED_FILE.name, "sample-leads.csv"}:
            continue
        rows.extend(read_csv(path, rejected))

    for path in sorted(DATA_DIR.glob("*.xlsx")):
        rows.extend(read_xlsx(path, rejected))

    merged: dict[str, MergedLead] = {}
    duplicates: list[dict[str, str]] = []

    for source in rows:
        row = finalize_row(source.normalized)
        email = row["email"].lower()
        if not EMAIL_RE.match(email):
            rejected.append({**source.raw, "sourceFile": row.get("sourceFile", ""), "rejectReason": "invalid email"})
            continue

        if email not in merged:
            merged[email] = MergedLead(row=row, sources=[source_id(row)])
            continue

        existing = merged[email]
        duplicates.append({
            "email": email,
            "existingSources": "; ".join(existing.sources),
            "duplicateSource": source_id(row),
            "existingCompany": existing.row.get("company", ""),
            "duplicateCompany": row.get("company", ""),
        })
        existing.duplicateCount += 1
        existing.sources.append(source_id(row))
        existing.row = merge_rows(existing.row, row)

    output_rows = sorted((lead.row for lead in merged.values()), key=lambda r: (r.get("niche", ""), r.get("company", ""), r["email"]))
    write_csv(OUT_FILE, OUTPUT_COLUMNS, output_rows)
    write_csv(DUPES_FILE, ["email", "existingSources", "duplicateSource", "existingCompany", "duplicateCompany"], duplicates)

    rejected_columns = sorted({k for r in rejected for k in r.keys()}) or ["rejectReason"]
    write_csv(REJECTED_FILE, rejected_columns, rejected)

    summary = {
        "inputRowsWithEmails": len(rows),
        "normalizedLeads": len(output_rows),
        "duplicateRows": len(duplicates),
        "rejectedRows": len(rejected),
        "byNiche": Counter(r.get("niche", "") for r in output_rows),
        "bySubNiche": Counter(r.get("subNiche", "") for r in output_rows),
        "byEmailStatus": Counter(r.get("emailStatus", "") for r in output_rows),
    }
    SUMMARY_FILE.write_text(json.dumps(summary, indent=2, default=dict) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2, default=dict))


def read_csv(path: Path, rejected: list[dict[str, str]]) -> list[SourceRow]:
    out: list[SourceRow] = []
    with path.open(newline="", encoding="utf-8-sig", errors="replace") as f:
        reader = csv.DictReader(f)
        for row_num, raw in enumerate(reader, start=2):
            source = normalize_mapping(raw)
            source["sourceFile"] = str(path)
            source["sourceSheet"] = ""
            source["source"] = source.get("source") or source_name(path)
            if not source.get("email"):
                rejected.append({**stringify_map(raw), "sourceFile": str(path), "row": str(row_num), "rejectReason": "missing email"})
                continue
            out.append(SourceRow(source, stringify_map(raw)))
    return out


def read_xlsx(path: Path, rejected: list[dict[str, str]]) -> list[SourceRow]:
    out: list[SourceRow] = []
    workbook = openpyxl.load_workbook(path, read_only=True, data_only=True)
    for sheet in workbook.worksheets:
        iterator = sheet.iter_rows(values_only=True)
        try:
            headers = next(iterator)
        except StopIteration:
            continue
        keys = [stringify(h) for h in headers]
        for row_num, values in enumerate(iterator, start=2):
            raw = {keys[i]: stringify(values[i]) if i < len(values) else "" for i in range(len(keys)) if keys[i]}
            if not any(raw.values()):
                continue
            source = normalize_mapping(raw)
            source["sourceFile"] = str(path)
            source["sourceSheet"] = sheet.title
            source["source"] = source.get("source") or source_name(path)
            if not source.get("email"):
                rejected.append({**raw, "sourceFile": str(path), "sourceSheet": sheet.title, "row": str(row_num), "rejectReason": "missing email"})
                continue
            out.append(SourceRow(source, raw))
    return out


def normalize_mapping(raw: dict[str, Any]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    extras: dict[str, str] = {}
    for key, value in raw.items():
        value_s = stringify(value)
        if not value_s:
            continue
        mapped = HEADER_MAP.get(clean_header(key))
        if mapped:
            normalized[mapped] = value_s
        else:
            extras[key] = value_s
    if extras:
        normalized["notes"] = merge_text(normalized.get("notes", ""), " | ".join(f"{k}: {v}" for k, v in extras.items()))
    return normalized


def finalize_row(row: dict[str, str]) -> dict[str, str]:
    out = {col: row.get(col, "") for col in OUTPUT_COLUMNS}
    if not out["email"]:
        out["email"] = first_email(out.get("alternateEmails", ""))
    out["email"] = out["email"].strip().lower()
    if not out["name"]:
        out["name"] = " ".join(x for x in [out["firstName"], out["lastName"]] if x).strip()
    if not out["firstName"] and out["name"]:
        parts = out["name"].split()
        out["firstName"] = parts[0]
        out["lastName"] = out["lastName"] or (" ".join(parts[1:]) if len(parts) > 1 else "")
    if not out["location"]:
        out["location"] = ", ".join(x for x in [out["city"], out["state"], out["country"]] if x)
    if not out["industry"] and out["niche"]:
        out["industry"] = out["niche"]
    if out["niche"]:
        out["niche"] = normalize_niche(out["niche"])
    if out["industry"]:
        out["industry"] = normalize_industry(out["industry"])
    if not out["niche"]:
        out["niche"] = infer_niche(out)
    if not out["subNiche"]:
        out["subNiche"] = infer_sub_niche(out)
    if out["website"] and not out["website"].startswith(("http://", "https://")):
        out["website"] = "https://" + out["website"]
    return out


def normalize_niche(value: str) -> str:
    text = value.strip().lower()
    if text in {"invesment", "investment", "finance", "financial", "financial services"}:
        return "Financial Services"
    if text in {"medical", "medical practice", "healthcare", "health care", "hospital & health care"}:
        return "Healthcare"
    if text in {"traveling", "travel", "travel agency"}:
        return "Travel"
    if text in {"real estate", "realestate"}:
        return "Real Estate"
    if text in {"law", "law practice", "legal", "legal services"}:
        return "Law"
    if text in {"construction", "contractors", "contractor", "specialty trade contractors", "hvac and refrigeration equipment manufacturing"}:
        return "Construction"
    if text in {"it", "information technology & services", "tech", "tech start up", "technology"}:
        return "Technology"
    if text in {"consumer electronics", "computer software", "internet", "software"}:
        return "Technology"
    return title_case(value)


def normalize_industry(value: str) -> str:
    text = value.strip().lower()
    if text in {"hospital & health care", "health care", "healthcare", "medical", "medical practice"}:
        return "Healthcare"
    if text in {"law practice", "legal services"}:
        return "Law"
    if text in {"financial services", "finance", "insurance", "venture capital & private equity"}:
        return "Financial Services"
    if text in {"real estate"}:
        return "Real Estate"
    if text in {"construction", "specialty trade contractors", "hvac and refrigeration equipment manufacturing"}:
        return "Construction"
    if text in {"consumer electronics", "computer software", "information technology & services"}:
        return "Technology"
    return title_case(value)


def infer_niche(row: dict[str, str]) -> str:
    industry = row.get("industry", "").lower()
    if industry:
        normalized = normalize_industry(industry)
        if normalized not in {"", "Other"}:
            return normalize_niche(normalized)
    text = " ".join([row.get("keywords", ""), row.get("sourceSheet", "")]).lower()
    if any(contains_term(text, x) for x in ["construction", "contractor", "roof", "hvac", "paving"]):
        return "Construction"
    if any(contains_term(text, x) for x in ["law", "legal", "attorney"]):
        return "Law"
    if any(contains_term(text, x) for x in ["medical", "health", "physician", "hospital"]):
        return "Healthcare"
    if "real estate" in text:
        return "Real Estate"
    if any(x in text for x in ["financial", "insurance", "venture capital", "private equity"]):
        return "Financial Services"
    if "travel" in text:
        return "Travel"
    return title_case(row.get("industry", "")) or "Uncategorized"


def infer_sub_niche(row: dict[str, str]) -> str:
    text = " ".join([row.get("company", ""), row.get("title", ""), row.get("industry", ""), row.get("keywords", ""), row.get("sourceSheet", ""), row.get("niche", "")]).lower()
    for label, terms in SUBNICHE_RULES:
        if any(contains_term(text, term) for term in terms):
            return label
    return ""


def contains_term(text: str, term: str) -> bool:
    return re.search(rf"(?<![a-z0-9]){re.escape(term)}(?![a-z0-9])", text) is not None


def merge_rows(a: dict[str, str], b: dict[str, str]) -> dict[str, str]:
    out = dict(a)
    for key in OUTPUT_COLUMNS:
        av = out.get(key, "")
        bv = b.get(key, "")
        if not av and bv:
            out[key] = bv
        elif key in {"keywords", "notes", "source", "sourceFile", "sourceSheet"} and bv and bv not in av:
            out[key] = merge_text(av, bv)
    if score_row(b) > score_row(out):
        for key in ["name", "firstName", "lastName", "title", "company", "industry", "website", "linkedin", "niche", "subNiche"]:
            if b.get(key):
                out[key] = b[key]
    return finalize_row(out)


def score_row(row: dict[str, str]) -> int:
    score = sum(1 for v in row.values() if v)
    if row.get("emailStatus", "").lower() == "verified":
        score += 5
    if row.get("website"):
        score += 3
    if row.get("keywords"):
        score += 2
    return score


def write_csv(path: Path, columns: list[str], rows: list[dict[str, str]]) -> None:
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def source_name(path: Path) -> str:
    if path.name.startswith("APOLLO") or path.name.startswith("Apollo"):
        return "apollo-export"
    if path.name == "manual-pasted-leads.csv":
        return "manual-pasted"
    return path.stem


def source_id(row: dict[str, str]) -> str:
    sheet = f":{row.get('sourceSheet')}" if row.get("sourceSheet") else ""
    return f"{row.get('sourceFile', '')}{sheet}"


def clean_header(key: str) -> str:
    return re.sub(r"\s+", " ", str(key).replace("_", " ").strip().lower())


def stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def stringify_map(raw: dict[str, Any]) -> dict[str, str]:
    return {str(k): stringify(v) for k, v in raw.items()}


def first_email(value: str) -> str:
    match = re.search(r"[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+", value)
    return match.group(0) if match else ""


def merge_text(a: str, b: str) -> str:
    if not a:
        return b
    if not b or b in a:
        return a
    return f"{a}; {b}"


def title_case(value: str) -> str:
    return " ".join(part.capitalize() for part in value.split())


if __name__ == "__main__":
    main()
