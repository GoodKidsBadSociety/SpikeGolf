# Supabase-Setup für den granularen Sync

Der Sync speichert den App-Zustand jetzt **pro Datensatz** (Spieler, Kurs,
Runde, einzelner Score) statt als einen großen Block. Dafür braucht es
**einmalig** eine neue Tabelle `app_kv`.

## 1. SQL ausführen

Supabase-Dashboard → **SQL Editor** → neues Query → einfügen → **Run**:

```sql
-- Spikegolf: per-record sync store
create table if not exists public.app_kv (
  k          text primary key,
  v          jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_kv enable row level security;

-- Anonyme Familien-Nutzung: voller Lese-/Schreibzugriff (wie beim alten Sync).
create policy "app_kv read"   on public.app_kv for select using (true);
create policy "app_kv insert" on public.app_kv for insert with check (true);
create policy "app_kv update" on public.app_kv for update using (true) with check (true);
create policy "app_kv delete" on public.app_kv for delete using (true);

-- Realtime: Zeilenänderungen an verbundene Geräte pushen.
alter publication supabase_realtime add table public.app_kv;
```

`Success. No rows returned` ist das erwartete Ergebnis (DDL gibt keine Zeilen zurück).

## 2. Anonyme Anmeldung muss aktiv sein

Dashboard → **Authentication → Providers → Anonymous sign-ins** → *Enabled*.
(War für den alten Sync schon nötig, sollte also bereits an sein.)

## 3. Fertig

- Beim ersten Start migriert die App den bisherigen Cloud-Stand automatisch
  (liest die alte `app_state`-Zeile, falls vorhanden, und füllt `app_kv`).
- Fehlt die Tabelle, läuft die App **lokal weiter** (kein Absturz) — der Sync
  schaltet sich einfach ab, bis das SQL ausgeführt ist.
- Die alte Tabelle `app_state` kann bleiben; sie wird nach der Migration nicht
  mehr geschrieben und schadet nicht.

## Was sich technisch ändert

| vorher | nachher |
|---|---|
| 1 Zeile `app_state` mit dem ganzen Zustand | viele kleine Zeilen in `app_kv` |
| jede Änderung überschreibt **alles** | jede Änderung schreibt **nur ihren Datensatz** |
| „last writer wins" über den ganzen Zustand | „last writer wins" **pro Datensatz** |
| Push war fire-and-forget | persistente Outbox + Retry (offline-fest) |

Ergebnis: Zwei Leute, die gleichzeitig verschiedene Scores/Kurse eintragen,
überschreiben sich nicht mehr gegenseitig; offline getippte Scores gehen bei
wackligem Netz nicht verloren, sondern werden beim Reconnect nachgespielt.
