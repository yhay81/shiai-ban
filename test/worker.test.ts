import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";

import { app, type Bindings } from "../src/worker";

const migrationPath = fileURLToPath(new URL("../migrations/0001_tournaments.sql", import.meta.url));
const origin = "http://localhost";
const sessions = [
  "a2d0e2f2-66fd-4fd4-8e87-b0ef67ad194a",
  "b3d0e2f2-66fd-4fd4-8e87-b0ef67ad194b",
  "c4d0e2f2-66fd-4fd4-8e87-b0ef67ad194c",
  "d5d0e2f2-66fd-4fd4-8e87-b0ef67ad194d",
  "e6d0e2f2-66fd-4fd4-8e87-b0ef67ad194e",
  "f7d0e2f2-66fd-4fd4-8e87-b0ef67ad194f",
];

let miniflare: Miniflare;
let bindings: Bindings;

const headers = (session = sessions[0], key = "", qa = false) => ({
  "content-type": "application/json",
  origin,
  "x-shiai-key": key,
  "x-shiai-qa": qa ? "1" : "0",
  "x-shiai-session": session,
});

const validTournament = (overrides: Record<string, unknown> = {}) => ({
  maxTeams: 6,
  pitchCount: 2,
  publicNote: "各試合の5分前にピッチ横へ集合",
  slotMinutes: 20,
  sportLabel: "サッカー",
  startsAt: Math.floor(Date.now() / 1000) + 7200,
  title: "西町ジュニア交流リーグ",
  venue: "西町運動広場",
  website: "",
  ...overrides,
});

const keyFromUrl = (url: string) =>
  new URLSearchParams(new URL(url, origin).hash.slice(1)).get("key") ?? "";

const createTournament = async (
  overrides: Record<string, unknown> = {},
  session = sessions[0],
  qa = false,
) => {
  const response = await app.request(
    "/api/tournaments",
    {
      body: JSON.stringify(validTournament(overrides)),
      headers: headers(session, "", qa),
      method: "POST",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{ eventUrl: string; id: string; manageUrl: string }>();
  return { ...body, organizerKey: keyFromUrl(body.manageUrl) };
};

const register = async (
  tournamentId: string,
  index: number,
  name = `チーム${index}`,
  qa = false,
) => {
  const response = await app.request(
    `/api/tournaments/${tournamentId}/register`,
    {
      body: JSON.stringify({ displayName: name, website: "" }),
      headers: headers(sessions[index], "", qa),
      method: "POST",
    },
    bindings,
  );
  expect(response.status).toBe(201);
  const body = await response.json<{ id: string; passUrl: string }>();
  return { ...body, key: keyFromUrl(body.passUrl), session: sessions[index] };
};

const startWithTeams = async (teamCount = 4) => {
  const tournament = await createTournament();
  const teams = await Promise.all(
    Array.from({ length: teamCount }, (_, index) => register(tournament.id, index + 1)),
  );
  const response = await app.request(
    `/api/tournaments/${tournament.id}/start`,
    { headers: headers(sessions[0], tournament.organizerKey), method: "POST" },
    bindings,
  );
  expect(response.status).toBe(200);
  return { teams, tournament };
};

beforeEach(async () => {
  miniflare = new Miniflare({
    d1Databases: { DB: "shiai-ban-test" },
    modules: true,
    script: "export default { fetch() { return new Response('test') } }",
  });
  const database = await miniflare.getD1Database("DB");
  const migration = await readFile(migrationPath, "utf8");
  for (const statement of migration
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean))
    await database.prepare(statement).run();
  bindings = {
    ASSETS: { fetch: async () => new Response("asset") } as unknown as Fetcher,
    DB: database as unknown as D1Database,
  };
});

afterEach(async () => miniflare.dispose());

describe("public pages", () => {
  it.each([
    ["/", 'class="pairing-board"', "https://shiai-ban.yhay81.com/"],
    ["/guide", 'class="guide-cards"', "https://shiai-ban.yhay81.com/guide"],
    ["/privacy", 'class="data-grid"', "https://shiai-ban.yhay81.com/privacy"],
  ])("%s returns a product-specific surface", async (path, marker, canonical) => {
    const response = await app.request(path, undefined, bindings);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain(marker);
    expect(html).toContain(`href="${canonical}" rel="canonical"`);
    expect(html).toContain("試合盤");
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });
});

describe("matchday flow", () => {
  it("creates an unlisted board without leaking capability keys", async () => {
    const tournament = await createTournament();
    const publicResponse = await app.request(
      `/api/tournaments/${tournament.id}`,
      undefined,
      bindings,
    );
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).not.toContain(tournament.organizerKey);
    const forbidden = await app.request(
      `/api/tournaments/${tournament.id}/manage`,
      { headers: headers() },
      bindings,
    );
    expect(forbidden.status).toBe(403);
    const allowed = await app.request(
      `/api/tournaments/${tournament.id}/manage`,
      { headers: headers(sessions[0], tournament.organizerKey) },
      bindings,
    );
    expect(allowed.status).toBe(200);
  });

  it("registers four teams and lays out a complete round robin", async () => {
    const { tournament } = await startWithTeams();
    const state = await (
      await app.request(`/api/tournaments/${tournament.id}`, undefined, bindings)
    ).json<{
      matches: Array<{ awayId: string; homeId: string; pitchNumber: number; slotNumber: number }>;
      tournament: { scheduleSlots: number };
    }>();
    expect(state.matches).toHaveLength(6);
    expect(
      new Set(state.matches.map((match) => [match.homeId, match.awayId].sort().join(":"))),
    ).toHaveProperty("size", 6);
    expect(state.tournament.scheduleSlots).toBe(3);
    expect(state.matches.every((match) => match.pitchNumber <= 2)).toBe(true);
  });

  it("requires at least three teams", async () => {
    const tournament = await createTournament();
    await register(tournament.id, 1);
    await register(tournament.id, 2);
    const response = await app.request(
      `/api/tournaments/${tournament.id}/start`,
      { headers: headers(sessions[0], tournament.organizerKey), method: "POST" },
      bindings,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "not_enough_teams" });
  });

  it("confirms a score only when both teams submit the same absolute score", async () => {
    const { teams, tournament } = await startWithTeams();
    const state = await (
      await app.request(`/api/tournaments/${tournament.id}`, undefined, bindings)
    ).json<{ matches: Array<{ awayId: string; homeId: string; id: string }> }>();
    const match = state.matches[0];
    const participants = teams.filter(
      (team) => team.id === match.homeId || team.id === match.awayId,
    );
    for (const team of participants) {
      const response = await app.request(
        `/api/tournaments/${tournament.id}/matches/${match.id}/report`,
        {
          body: JSON.stringify({ awayScore: 1, homeScore: 2 }),
          headers: headers(team.session, team.key),
          method: "POST",
        },
        bindings,
      );
      expect(response.status).toBe(200);
    }
    const updated = await (
      await app.request(`/api/tournaments/${tournament.id}`, undefined, bindings)
    ).json<{
      matches: Array<{ id: string; score: string; status: string }>;
      standings: Array<{ name: string; points: number }>;
    }>();
    expect(updated.matches.find((item) => item.id === match.id)).toMatchObject({
      score: "2:1",
      status: "confirmed",
    });
    expect(updated.standings[0].points).toBe(3);
  });

  it("marks differing score reports as disputed and lets the organizer resolve them", async () => {
    const { teams, tournament } = await startWithTeams(3);
    const state = await (
      await app.request(`/api/tournaments/${tournament.id}`, undefined, bindings)
    ).json<{ matches: Array<{ awayId: string; homeId: string; id: string }> }>();
    const match = state.matches[0];
    const participants = teams.filter(
      (team) => team.id === match.homeId || team.id === match.awayId,
    );
    await app.request(
      `/api/tournaments/${tournament.id}/matches/${match.id}/report`,
      {
        body: JSON.stringify({ awayScore: 0, homeScore: 1 }),
        headers: headers(participants[0].session, participants[0].key),
        method: "POST",
      },
      bindings,
    );
    const disputed = await app.request(
      `/api/tournaments/${tournament.id}/matches/${match.id}/report`,
      {
        body: JSON.stringify({ awayScore: 1, homeScore: 1 }),
        headers: headers(participants[1].session, participants[1].key),
        method: "POST",
      },
      bindings,
    );
    expect(await disputed.json()).toMatchObject({ status: "disputed" });
    const resolved = await app.request(
      `/api/tournaments/${tournament.id}/matches/${match.id}/resolve`,
      {
        body: JSON.stringify({ awayScore: 0, homeScore: 2 }),
        headers: headers(sessions[0], tournament.organizerKey),
        method: "POST",
      },
      bindings,
    );
    expect(resolved.status).toBe(200);
  });

  it("rejects a score report from a team outside the match", async () => {
    const { teams, tournament } = await startWithTeams();
    const state = await (
      await app.request(`/api/tournaments/${tournament.id}`, undefined, bindings)
    ).json<{ matches: Array<{ awayId: string; homeId: string; id: string }> }>();
    const match = state.matches[0];
    const outsider = teams.find((team) => team.id !== match.homeId && team.id !== match.awayId)!;
    const response = await app.request(
      `/api/tournaments/${tournament.id}/matches/${match.id}/report`,
      {
        body: JSON.stringify({ awayScore: 0, homeScore: 1 }),
        headers: headers(outsider.session, outsider.key),
        method: "POST",
      },
      bindings,
    );
    expect(response.status).toBe(404);
  });

  it("exposes only the next pending match on a team pass", async () => {
    const { teams, tournament } = await startWithTeams();
    const response = await app.request(
      `/api/tournaments/${tournament.id}/pass`,
      { headers: headers(teams[0].session, teams[0].key) },
      bindings,
    );
    const state = await response.json<{ participant: { match: { id: string } | null } }>();
    expect(response.status).toBe(200);
    expect(state.participant.match?.id).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("prevents duplicate sessions and contact details in team names", async () => {
    const tournament = await createTournament();
    await register(tournament.id, 1, "青葉SC");
    const duplicate = await app.request(
      `/api/tournaments/${tournament.id}/register`,
      {
        body: JSON.stringify({ displayName: "別チーム", website: "" }),
        headers: headers(sessions[1]),
        method: "POST",
      },
      bindings,
    );
    expect(duplicate.status).toBe(409);
    const contact = await app.request(
      `/api/tournaments/${tournament.id}/register`,
      {
        body: JSON.stringify({ displayName: "team@example.com", website: "" }),
        headers: headers(sessions[2]),
        method: "POST",
      },
      bindings,
    );
    expect(contact.status).toBe(400);
  });

  it("allows withdrawal only before the schedule starts", async () => {
    const tournament = await createTournament();
    const team = await register(tournament.id, 1);
    const dropped = await app.request(
      `/api/tournaments/${tournament.id}/drop`,
      { headers: headers(team.session, team.key), method: "POST" },
      bindings,
    );
    expect(dropped.status).toBe(200);
  });

  it("completes after every match receives an organizer-confirmed score", async () => {
    const { tournament } = await startWithTeams(3);
    const initial = await (
      await app.request(`/api/tournaments/${tournament.id}`, undefined, bindings)
    ).json<{ matches: Array<{ id: string }> }>();
    for (const match of initial.matches) {
      const response = await app.request(
        `/api/tournaments/${tournament.id}/matches/${match.id}/resolve`,
        {
          body: JSON.stringify({ awayScore: 0, homeScore: 1 }),
          headers: headers(sessions[0], tournament.organizerKey),
          method: "POST",
        },
        bindings,
      );
      expect(response.status).toBe(200);
    }
    const final = await (
      await app.request(`/api/tournaments/${tournament.id}`, undefined, bindings)
    ).json<{ tournament: { status: string } }>();
    expect(final.tournament.status).toBe("completed");
  });

  it("keeps QA telemetry separate from real-user metrics", async () => {
    await createTournament({}, sessions[0], true);
    const database = bindings.DB;
    const rows = await database
      .prepare("SELECT is_qa, COUNT(*) AS count FROM product_events GROUP BY is_qa ORDER BY is_qa")
      .all<{ count: number; is_qa: number }>();
    expect(rows.results).toEqual([{ count: 1, is_qa: 1 }]);
  });

  it("hides a board after three distinct safety reports", async () => {
    const tournament = await createTournament();
    for (let index = 1; index <= 3; index += 1) {
      const response = await app.request(
        `/api/tournaments/${tournament.id}/report`,
        {
          body: JSON.stringify({ reason: "unsafe" }),
          headers: headers(sessions[index]),
          method: "POST",
        },
        bindings,
      );
      expect(response.status).toBe(202);
    }
    const hidden = await app.request(`/api/tournaments/${tournament.id}`, undefined, bindings);
    expect(hidden.status).toBe(404);
  });

  it("exports organizer-only JSON and CSV snapshots", async () => {
    const tournament = await createTournament();
    const denied = await app.request(
      `/api/tournaments/${tournament.id}/snapshot.csv`,
      { headers: headers() },
      bindings,
    );
    expect(denied.status).toBe(403);
    const allowed = await app.request(
      `/api/tournaments/${tournament.id}/snapshot.csv`,
      { headers: headers(sessions[0], tournament.organizerKey) },
      bindings,
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-disposition")).toContain("shiai-ban-");
  });

  it("rejects cross-origin mutation and over-limit scores", async () => {
    const tournament = await createTournament();
    const crossOrigin = await app.request(
      `/api/tournaments/${tournament.id}/register`,
      {
        body: JSON.stringify({ displayName: "青葉SC", website: "" }),
        headers: { ...headers(sessions[1]), origin: "https://evil.example" },
        method: "POST",
      },
      bindings,
    );
    expect(crossOrigin.status).toBe(403);
    const { teams, tournament: active } = await startWithTeams(3);
    const state = await (
      await app.request(`/api/tournaments/${active.id}`, undefined, bindings)
    ).json<{ matches: Array<{ awayId: string; homeId: string; id: string }> }>();
    const participant = teams.find(
      (team) => team.id === state.matches[0].homeId || team.id === state.matches[0].awayId,
    )!;
    const invalid = await app.request(
      `/api/tournaments/${active.id}/matches/${state.matches[0].id}/report`,
      {
        body: JSON.stringify({ awayScore: 100, homeScore: 1 }),
        headers: headers(participant.session, participant.key),
        method: "POST",
      },
      bindings,
    );
    expect(invalid.status).toBe(400);
  });
});
