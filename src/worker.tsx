import { Hono } from "hono";
import type { Context } from "hono";
import { requestId } from "hono/request-id";

import {
  calculateStandings,
  createRoundRobinSchedule,
  type LeagueMatch,
  type LeagueTeam,
} from "./domain/league";

export type Bindings = {
  ASSETS: Fetcher;
  DB: D1Database;
};

type Variables = { requestId: string };
type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;
type TournamentStatus = "active" | "cancelled" | "completed" | "hidden" | "registration";

type TournamentRow = {
  created_at: number;
  creator_session_id: string;
  current_round: number;
  expires_at: number;
  game_label: string;
  id: string;
  max_players: number;
  organizer_token_hash: string;
  planned_rounds: number;
  public_note: string;
  slot_minutes: number;
  starts_at: number;
  status: TournamentStatus;
  title: string;
  updated_at: number;
  venue: string;
};

type PlayerRow = {
  bye_count: number;
  checked_in: number;
  created_at: number;
  display_name: string;
  display_name_key: string;
  dropped: number;
  id: string;
  session_id: string;
  token_hash: string;
  tournament_id: string;
  updated_at: number;
};

type MatchRow = {
  confirmed_result: string;
  created_at: number;
  id: string;
  player1_id: string;
  player1_report: string;
  player2_id: string;
  player2_report: string;
  round_number: number;
  scheduled_at: number;
  status: "confirmed" | "disputed" | "pending";
  table_number: number;
  tournament_id: string;
  updated_at: number;
};

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 429,
  ) {
    super(code);
  }
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const idPattern = /^[0-9a-f]{32}$/;
const tokenPattern = /^[0-9a-f]{64}$/;
const sessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/iu;
const phonePattern = /(?:\+?81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/u;
const linkPattern = /(?:https?:\/\/|www\.)/iu;
const reportReasons = new Set(["other", "spam", "unsafe"]);
const telemetryNames = new Set([
  "visited",
  "tournament_created",
  "team_registered",
  "schedule_started",
  "score_reported",
  "result_confirmed",
  "tournament_completed",
  "public_board_viewed",
  "returned",
]);

const nowSeconds = () => Math.floor(Date.now() / 1000);
const jstDay = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

const randomHex = (byteLength: number) => {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const sha256 = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const enforceSameOrigin = (c: AppContext) => {
  const fetchSite = c.req.header("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") throw new ApiError("cross_site_request", 403);
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    throw new ApiError("cross_site_request", 403);
  }
};

const parseJson = async (c: AppContext, maximumBytes = 4096) => {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new ApiError("unsupported_media_type", 415);
  }
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > maximumBytes) throw new ApiError("payload_too_large", 413);
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
    throw new ApiError("payload_too_large", 413);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ApiError("invalid_json", 400);
  }
};

const objectPayload = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ApiError("invalid_request", 400);
  }
  return payload as Record<string, unknown>;
};

const cleanText = (
  payload: Record<string, unknown>,
  key: string,
  maximum: number,
  allowEmpty = false,
) => {
  if (typeof payload[key] !== "string") throw new ApiError(`invalid_${key}`, 400);
  const value = payload[key].replace(/\r\n?/gu, "\n").trim();
  if ((!allowEmpty && value.length === 0) || value.length > maximum) {
    throw new ApiError(`invalid_${key}`, 400);
  }
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if ((point < 32 && point !== 9 && point !== 10) || point === 127) {
      throw new ApiError(`invalid_${key}`, 400);
    }
  }
  if (emailPattern.test(value) || phonePattern.test(value) || linkPattern.test(value)) {
    throw new ApiError(`contact_not_allowed_in_${key}`, 400);
  }
  return value;
};

const integerValue = (
  payload: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
) => {
  const value = payload[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new ApiError(`invalid_${key}`, 400);
  }
  return value as number;
};

const validateId = (value: string) => {
  if (!idPattern.test(value)) throw new ApiError("not_found", 404);
  return value;
};

const sessionId = (c: AppContext) => {
  const value = c.req.header("x-shiai-session") ?? "";
  if (!sessionPattern.test(value)) throw new ApiError("invalid_session", 400);
  return value.toLowerCase();
};

const capability = (c: AppContext) => {
  const value = c.req.header("x-shiai-key") ?? "";
  if (!tokenPattern.test(value)) throw new ApiError("invalid_capability", 403);
  return value;
};

const tournamentById = async (database: D1Database, id: string) => {
  const row = await database
    .prepare("SELECT * FROM tournaments WHERE id = ? AND expires_at > ?")
    .bind(id, nowSeconds())
    .first<TournamentRow>();
  if (!row) throw new ApiError("not_found", 404);
  return row;
};

const organizerTournament = async (c: AppContext, id: string) => {
  const tournament = await tournamentById(c.env.DB, id);
  const suppliedHash = await sha256(capability(c));
  if (!constantTimeEqual(tournament.organizer_token_hash, suppliedHash)) {
    throw new ApiError("invalid_capability", 403);
  }
  return tournament;
};

const participant = async (c: AppContext, tournamentId: string) => {
  const suppliedHash = await sha256(capability(c));
  const row = await c.env.DB.prepare(
    "SELECT * FROM players WHERE tournament_id = ? AND token_hash = ?",
  )
    .bind(tournamentId, suppliedHash)
    .first<PlayerRow>();
  if (!row || !constantTimeEqual(row.token_hash, suppliedHash)) {
    throw new ApiError("invalid_capability", 403);
  }
  return row;
};

const recordEvent = async (
  c: AppContext,
  name: string,
  tournamentId: string,
  actorSession?: string,
) => {
  if (!telemetryNames.has(name)) return;
  const actor = actorSession ?? sessionId(c);
  const qa = c.req.header("x-shiai-qa") === "1" ? 1 : 0;
  await c.env.DB.prepare(
    `INSERT INTO product_events (name, session_id, tournament_id, day, created_at, is_qa)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(name, actor, tournamentId, jstDay(), nowSeconds(), qa)
    .run();
};

const getPlayers = async (database: D1Database, tournamentId: string) => {
  const result = await database
    .prepare("SELECT * FROM players WHERE tournament_id = ? ORDER BY created_at, id")
    .bind(tournamentId)
    .all<PlayerRow>();
  return result.results;
};

const getMatches = async (database: D1Database, tournamentId: string) => {
  const result = await database
    .prepare("SELECT * FROM matches WHERE tournament_id = ? ORDER BY round_number, table_number")
    .bind(tournamentId)
    .all<MatchRow>();
  return result.results;
};

const leagueTeams = (players: PlayerRow[]): LeagueTeam[] =>
  players.map((player) => ({
    displayName: player.display_name,
    id: player.id,
  }));

const leagueMatches = (matches: MatchRow[]): LeagueMatch[] =>
  matches.map((match) => ({
    awayId: match.player2_id,
    confirmedScore: match.confirmed_result,
    homeId: match.player1_id,
  }));

const publicState = async (database: D1Database, tournament: TournamentRow) => {
  const players = await getPlayers(database, tournament.id);
  const matches = await getMatches(database, tournament.id);
  const playerById = new Map(players.map((player) => [player.id, player]));
  const standings = calculateStandings(leagueTeams(players), leagueMatches(matches));
  const nextPending = matches.find((match) => match.status !== "confirmed");
  return {
    tournament: {
      pitchCount: tournament.planned_rounds,
      slotMinutes: tournament.slot_minutes,
      sportLabel: tournament.game_label,
      id: tournament.id,
      maxTeams: tournament.max_players,
      nextSlot: nextPending?.round_number ?? tournament.current_round,
      publicNote: tournament.public_note,
      scheduleSlots: tournament.current_round,
      startsAt: tournament.starts_at,
      status: tournament.status,
      title: tournament.title,
      venue: tournament.venue,
    },
    players: players.map((player) => ({
      checkedIn: player.checked_in === 1,
      displayName: player.display_name,
      dropped: player.dropped === 1,
      id: player.id,
    })),
    matches: matches.map((match) => ({
      away: playerById.get(match.player2_id)?.display_name ?? "不明",
      awayId: match.player2_id,
      home: playerById.get(match.player1_id)?.display_name ?? "不明",
      homeId: match.player1_id,
      id: match.id,
      pitchNumber: match.table_number,
      scheduledAt: match.scheduled_at,
      score: match.confirmed_result,
      slotNumber: match.round_number,
      status: match.status,
    })),
    standings: standings.map((standing, index) => ({
      draws: standing.draws,
      goalDifference: standing.goalDifference,
      goalsAgainst: standing.goalsAgainst,
      goalsFor: standing.goalsFor,
      losses: standing.losses,
      played: standing.played,
      name: standing.displayName,
      points: standing.points,
      rank: index + 1,
      wins: standing.wins,
    })),
  };
};

const createSchedule = async (database: D1Database, tournament: TournamentRow) => {
  const players = (await getPlayers(database, tournament.id)).filter(
    (player) => player.checked_in === 1 && player.dropped === 0,
  );
  const pairings = createRoundRobinSchedule(leagueTeams(players), tournament.planned_rounds);
  const timestamp = nowSeconds();
  const statements = pairings.map((pairing) =>
    database
      .prepare(
        `INSERT INTO matches
          (id, tournament_id, round_number, table_number, scheduled_at, player1_id, player2_id,
           confirmed_result, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        randomHex(16),
        tournament.id,
        pairing.slotNumber,
        pairing.pitchNumber,
        tournament.starts_at + (pairing.slotNumber - 1) * tournament.slot_minutes * 60,
        pairing.homeId,
        pairing.awayId,
        "",
        "pending",
        timestamp,
        timestamp,
      ),
  );
  if (statements.length > 0) await database.batch(statements);
  return pairings.reduce((highest, pairing) => Math.max(highest, pairing.slotNumber), 0);
};

const finishIfReady = async (c: AppContext, tournamentId: string) => {
  const tournament = await tournamentById(c.env.DB, tournamentId);
  if (tournament.status !== "active") return false;
  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM matches
       WHERE tournament_id = ? AND status != 'confirmed'`,
  )
    .bind(tournamentId)
    .first<{ count: number }>();
  if ((pending?.count ?? 1) !== 0) return false;
  const changed = await c.env.DB.prepare(
    `UPDATE tournaments SET status = 'completed', updated_at = ?
       WHERE id = ? AND status = 'active'`,
  )
    .bind(nowSeconds(), tournamentId)
    .run();
  if ((changed.meta.changes ?? 0) > 0) {
    await recordEvent(c, "tournament_completed", tournamentId, tournament.creator_session_id);
    return true;
  }
  return false;
};

const statusLabel: Record<TournamentStatus, string> = {
  active: "進行中",
  cancelled: "中止",
  completed: "終了",
  hidden: "非表示",
  registration: "受付中",
};

const Layout = ({
  canonical,
  children,
  description,
  noindex = false,
  script,
  title,
}: {
  canonical: string;
  children: unknown;
  description: string;
  noindex?: boolean;
  script?: string;
  title: string;
}) => (
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta content="width=device-width, initial-scale=1" name="viewport" />
      <title>{title}</title>
      <meta content={description} name="description" />
      <link href={canonical} rel="canonical" />
      <meta content={noindex ? "noindex,nofollow" : "index,follow"} name="robots" />
      <meta content="website" property="og:type" />
      <meta content={title} property="og:title" />
      <meta content={description} property="og:description" />
      <meta content={canonical} property="og:url" />
      <meta content="https://shiai-ban.yhay81.com/og.svg" property="og:image" />
      <meta content="#17463b" name="theme-color" />
      <link href="/favicon.svg" rel="icon" type="image/svg+xml" />
      <link href="/manifest.webmanifest" rel="manifest" />
      <link href="/styles.css" rel="stylesheet" />
      {script ? <script defer src={script}></script> : null}
    </head>
    <body>
      <header class="site-header">
        <a aria-label="試合盤 ホーム" class="brand" href="/">
          <span aria-hidden="true" class="brand-mark">
            試
          </span>
          <span>試合盤</span>
        </a>
        <nav aria-label="主なページ">
          <a href="/guide">使い方</a>
          <a href="/privacy">データ</a>
        </nav>
      </header>
      {children}
      <footer>
        <span>試合盤</span>
        <span>チーム名だけの一日リーグ</span>
        <a href="https://github.com/yhay81/shiai-ban">GitHub</a>
      </footer>
    </body>
  </html>
);

const MatchSlip = ({
  away,
  home,
  pitch,
  time,
}: {
  away: string;
  home: string;
  pitch: number;
  time: string;
}) => (
  <article class="table-slip">
    <span class="table-number">P{pitch}</span>
    <time>{time}</time>
    <div class="player-card">{home}</div>
    <span class="versus">―</span>
    <div class="player-card">{away}</div>
    <div class="result-stamps" aria-hidden="true">
      <i>2</i>
      <i>:</i>
      <i>1</i>
    </div>
  </article>
);

const Home = () => (
  <Layout
    canonical="https://shiai-ban.yhay81.com/"
    description="チーム受付、総当たり日程、双方の得点確認、順位を一つの会場盤で進めます。"
    script="/app.js"
    title="試合盤｜一日リーグの日程と得点確認"
  >
    <main data-page="home">
      <section class="hero">
        <div class="round-dial" aria-label="第3試合枠">
          <span>NEXT</span>
          <strong>3</strong>
          <small>10:40</small>
        </div>
        <div class="hero-copy">
          <p class="eyebrow">LINEUP · SCORE · STANDINGS</p>
          <h1>次の笛まで、ひと目で。</h1>
          <p>
            チーム札を配れば、全試合の日程、次のピッチ、双方確認した得点、順位が同じ盤面で動きます。
          </p>
          <button class="primary" data-open-create type="button">
            会場盤をつくる
          </button>
        </div>
        <div class="pairing-board" aria-label="対戦組合せの見本">
          <div class="board-top">
            <span>10:40 · 第3枠</span>
            <span>2 PITCHES</span>
          </div>
          <MatchSlip away="青葉SC" home="港ジュニア" pitch={1} time="10:40" />
          <MatchSlip away="西町FC" home="北野クラブ" pitch={2} time="10:40" />
          <div class="mini-standing" aria-hidden="true">
            <b>1</b>
            <span>港ジュニア</span>
            <strong>6</strong>
            <b>2</b>
            <span>青葉SC</span>
            <strong>4</strong>
            <b>3</b>
            <span>北野クラブ</span>
            <strong>3</strong>
          </div>
        </div>
      </section>

      <section class="flow-strip" aria-label="大会の流れ">
        <div>
          <b>01</b>
          <span>チーム札</span>
          <small>チーム名だけで受付</small>
        </div>
        <div>
          <b>02</b>
          <span>試合枠</span>
          <small>ピッチ数から自動配置</small>
        </div>
        <div>
          <b>03</b>
          <span>得点札</span>
          <small>両チーム一致で確定</small>
        </div>
        <div>
          <b>04</b>
          <span>順位盤</span>
          <small>勝点・得失点差を更新</small>
        </div>
      </section>

      <dialog id="create-dialog">
        <form data-create-form method="dialog">
          <div class="dialog-head">
            <div>
              <p class="eyebrow">NEW MATCHDAY</p>
              <h2>会場盤をつくる</h2>
            </div>
            <button aria-label="閉じる" class="icon-button" data-close-dialog type="button">
              ×
            </button>
          </div>
          <div class="form-grid">
            <label class="wide">
              大会名
              <input maxLength={80} name="title" required />
            </label>
            <label>
              競技
              <input maxLength={40} name="sportLabel" required value="サッカー" />
            </label>
            <label>
              会場名
              <input maxLength={80} name="venue" required />
            </label>
            <label>
              開始日時
              <input name="startsAt" required type="datetime-local" />
            </label>
            <label>
              チーム上限
              <input max={12} min={3} name="maxTeams" type="number" value="6" />
            </label>
            <label>
              ピッチ数
              <select name="pitchCount">
                <option selected>1</option>
                <option>2</option>
                <option>3</option>
              </select>
            </label>
            <label>
              1試合枠
              <select name="slotMinutes">
                <option>10</option>
                <option>15</option>
                <option selected>20</option>
                <option>25</option>
                <option>30</option>
                <option>40</option>
                <option>60</option>
              </select>
            </label>
            <label class="wide">
              公開メモ（任意）<textarea maxLength={400} name="publicNote"></textarea>
            </label>
            <label class="trap" aria-hidden="true">
              ウェブサイト
              <input name="website" tabIndex={-1} />
            </label>
          </div>
          <p class="form-note">
            選手名や連絡先は入力しないでください。主催鍵は作成後、この端末だけへ保存します。
          </p>
          <p aria-live="polite" class="form-error" data-form-error></p>
          <button class="primary wide-button" type="submit">
            会場盤をひらく
          </button>
        </form>
      </dialog>
    </main>
  </Layout>
);

const BoardShell = ({ id, mode }: { id: string; mode: "event" | "manage" | "pass" }) => {
  const privateMode = mode !== "event";
  const title = mode === "manage" ? "主催盤面" : mode === "pass" ? "チーム札" : "公開盤面";
  return (
    <Layout
      canonical={`https://shiai-ban.yhay81.com/${mode === "event" ? "t" : mode === "manage" ? "m" : "p"}/${id}`}
      description="一日リーグの試合時刻、ピッチ、得点、順位を確認できます。"
      noindex
      script="/board.js"
      title={`${title}｜試合盤`}
    >
      <main class="board-page" data-id={id} data-page={mode}>
        <section class="board-loading">
          <div class="round-dial small">
            <span>NEXT</span>
            <strong>–</strong>
            <small>loading</small>
          </div>
          <p>盤面を整えています…</p>
        </section>
        <section class="board-app" hidden data-board-app>
          <div class="event-heading">
            <div>
              <p class="eyebrow" data-sport></p>
              <h1 data-title></h1>
              <p class="event-meta">
                <span data-start></span>
                <span data-venue></span>
              </p>
            </div>
            <span class="status-badge" data-status></span>
          </div>
          <div class="board-alert" hidden data-alert></div>
          <div data-mode-panel></div>
          <div class="tab-row" role="tablist">
            <button class="tab active" data-tab="pairings" type="button">
              試合
            </button>
            <button class="tab" data-tab="standings" type="button">
              順位
            </button>
            <button class="tab" data-tab="players" type="button">
              チーム
            </button>
          </div>
          <section class="tab-panel" data-panel="pairings"></section>
          <section class="tab-panel" data-panel="standings" hidden></section>
          <section class="tab-panel" data-panel="players" hidden></section>
          {privateMode ? (
            <p class="capability-note">このURLの #key は本人だけで保管してください。</p>
          ) : null}
        </section>
      </main>
    </Layout>
  );
};

const Guide = () => (
  <Layout
    canonical="https://shiai-ban.yhay81.com/guide"
    description="試合盤で一日リーグを進める手順と、得点確認の仕組みです。"
    title="使い方｜試合盤"
  >
    <main class="info-page">
      <div class="info-heading">
        <div class="round-dial small">
          <span>FLOW</span>
          <strong>4</strong>
          <small>steps</small>
        </div>
        <div>
          <p class="eyebrow">MATCHDAY FLOW</p>
          <h1>札を渡して、笛をつなぐ。</h1>
        </div>
      </div>
      <ol class="guide-cards">
        <li>
          <b>01</b>
          <div>
            <h2>会場盤をつくる</h2>
            <p>開始時刻、チーム上限、ピッチ数、1試合枠を決めます。</p>
          </div>
        </li>
        <li>
          <b>02</b>
          <div>
            <h2>公開URLを共有する</h2>
            <p>各チームはチーム名で登録し、自分専用のチーム札を受け取ります。</p>
          </div>
        </li>
        <li>
          <b>03</b>
          <div>
            <h2>3チームから開始する</h2>
            <p>総当たりの全試合を、ピッチ数に合わせた時刻表へ自動で並べます。</p>
          </div>
        </li>
        <li>
          <b>04</b>
          <div>
            <h2>双方で得点を入れる</h2>
            <p>両チームの申告が一致すると確定し、順位盤がすぐ更新されます。</p>
          </div>
        </li>
      </ol>
      <section class="rule-card">
        <h2>順位の決まり方</h2>
        <div class="score-row">
          <span>勝ち</span>
          <b>3点</b>
          <span>引分</span>
          <b>1点</b>
          <span>負け</span>
          <b>0点</b>
        </div>
        <p>
          勝点が同じときは、得失点差、総得点、チーム名の順で並べます。個人の選手名や得点者は扱いません。
        </p>
      </section>
    </main>
  </Layout>
);

const Privacy = () => (
  <Layout
    canonical="https://shiai-ban.yhay81.com/privacy"
    description="試合盤が保存するデータ、保存しないデータ、削除時期です。"
    title="データについて｜試合盤"
  >
    <main class="info-page">
      <div class="info-heading">
        <span class="brand-mark large">試</span>
        <div>
          <p class="eyebrow">DATA BOUNDARY</p>
          <h1>チーム名だけ。</h1>
        </div>
      </div>
      <div class="data-grid">
        <section class="data-card keep">
          <h2>保存する</h2>
          <ul>
            <li>チーム名</li>
            <li>大会名・競技・会場名</li>
            <li>試合時刻・得点・順位</li>
            <li>匿名の利用イベント</li>
          </ul>
        </section>
        <section class="data-card never">
          <h2>集めない</h2>
          <ul>
            <li>本名・メール・電話番号</li>
            <li>選手名・住所・年齢</li>
            <li>写真・位置情報</li>
            <li>決済情報・チャット</li>
          </ul>
        </section>
      </div>
      <p class="retention-note">
        大会データは開始21日後、匿名イベントは45日後を目安に削除します。鍵そのものは保存せず、照合用ハッシュだけを保存します。
      </p>
    </main>
  </Layout>
);

app.use("*", requestId());
app.use("*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  c.header("Referrer-Policy", "no-referrer");
  c.header(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
});

app.get("/", (c) => c.html(<Home />));
app.get("/guide", (c) => c.html(<Guide />));
app.get("/privacy", (c) => c.html(<Privacy />));
app.get("/t/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  await tournamentById(c.env.DB, id);
  return c.html(<BoardShell id={id} mode="event" />);
});
app.get("/m/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  await tournamentById(c.env.DB, id);
  return c.html(<BoardShell id={id} mode="manage" />);
});
app.get("/p/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  await tournamentById(c.env.DB, id);
  return c.html(<BoardShell id={id} mode="pass" />);
});

app.post("/api/events", async (c) => {
  enforceSameOrigin(c);
  const payload = objectPayload(await parseJson(c, 1024));
  const name = cleanText(payload, "name", 40);
  if (!telemetryNames.has(name)) throw new ApiError("invalid_event", 400);
  const tournamentId =
    typeof payload.tournamentId === "string" && idPattern.test(payload.tournamentId)
      ? payload.tournamentId
      : "";
  await recordEvent(c, name, tournamentId);
  return c.json({ ok: true }, 202);
});

app.post("/api/tournaments", async (c) => {
  enforceSameOrigin(c);
  const actor = sessionId(c);
  const payload = objectPayload(await parseJson(c));
  if (payload.website !== "") throw new ApiError("invalid_request", 400);
  const title = cleanText(payload, "title", 80);
  const gameLabel = cleanText(payload, "sportLabel", 40);
  const venue = cleanText(payload, "venue", 80);
  const publicNote = cleanText(payload, "publicNote", 300, true);
  const startsAt = integerValue(
    payload,
    "startsAt",
    nowSeconds() + 300,
    nowSeconds() + 120 * 86400,
  );
  const maxPlayers = integerValue(payload, "maxTeams", 3, 12);
  const plannedRounds = integerValue(payload, "pitchCount", 1, 3);
  const slotMinutes = integerValue(payload, "slotMinutes", 10, 60);
  const recent = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM tournaments WHERE creator_session_id = ? AND created_at > ?",
  )
    .bind(actor, nowSeconds() - 86400)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= 3) throw new ApiError("create_rate_limited", 429);

  const id = randomHex(16);
  const token = randomHex(32);
  const timestamp = nowSeconds();
  await c.env.DB.prepare(
    `INSERT INTO tournaments
       (id, organizer_token_hash, creator_session_id, title, game_label, venue, public_note,
        starts_at, max_players, planned_rounds, slot_minutes, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      await sha256(token),
      actor,
      title,
      gameLabel,
      venue,
      publicNote,
      startsAt,
      maxPlayers,
      plannedRounds,
      slotMinutes,
      timestamp,
      timestamp,
      startsAt + 21 * 86400,
    )
    .run();
  await recordEvent(c, "tournament_created", id, actor);
  return c.json(
    {
      eventUrl: `/t/${id}`,
      id,
      manageUrl: `/m/${id}#key=${token}`,
    },
    201,
  );
});

app.get("/api/tournaments/:id", async (c) => {
  const id = validateId(c.req.param("id"));
  const tournament = await tournamentById(c.env.DB, id);
  if (tournament.status === "hidden") throw new ApiError("not_found", 404);
  return c.json(await publicState(c.env.DB, tournament));
});

app.get("/api/tournaments/:id/manage", async (c) => {
  const id = validateId(c.req.param("id"));
  const tournament = await organizerTournament(c, id);
  const state = await publicState(c.env.DB, tournament);
  return c.json({ ...state, organizer: true });
});

app.get("/api/tournaments/:id/pass", async (c) => {
  const id = validateId(c.req.param("id"));
  const tournament = await tournamentById(c.env.DB, id);
  const player = await participant(c, id);
  const state = await publicState(c.env.DB, tournament);
  const currentMatch = (await getMatches(c.env.DB, id)).find(
    (match) =>
      match.status !== "confirmed" &&
      (match.player1_id === player.id || match.player2_id === player.id),
  );
  return c.json({
    ...state,
    participant: {
      checkedIn: player.checked_in === 1,
      displayName: player.display_name,
      dropped: player.dropped === 1,
      id: player.id,
      match: currentMatch
        ? {
            id: currentMatch.id,
            myReport:
              currentMatch.player1_id === player.id
                ? currentMatch.player1_report
                : currentMatch.player2_report,
            score: currentMatch.confirmed_result,
            side: currentMatch.player1_id === player.id ? "p1" : "p2",
            status: currentMatch.status,
          }
        : null,
    },
  });
});

app.post("/api/tournaments/:id/register", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const actor = sessionId(c);
  const tournament = await tournamentById(c.env.DB, id);
  if (tournament.status !== "registration") throw new ApiError("registration_closed", 409);
  const payload = objectPayload(await parseJson(c, 2048));
  if (payload.website !== "") throw new ApiError("invalid_request", 400);
  const displayName = cleanText(payload, "displayName", 32);
  const displayNameKey = displayName.normalize("NFKC").toLocaleLowerCase("ja");
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM players WHERE tournament_id = ?",
  )
    .bind(id)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= tournament.max_players) throw new ApiError("tournament_full", 409);
  const token = randomHex(32);
  const playerId = randomHex(16);
  const timestamp = nowSeconds();
  try {
    await c.env.DB.prepare(
      `INSERT INTO players
         (id, tournament_id, session_id, token_hash, display_name, display_name_key,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        playerId,
        id,
        actor,
        await sha256(token),
        displayName,
        displayNameKey,
        timestamp,
        timestamp,
      )
      .run();
  } catch {
    throw new ApiError("already_registered_or_name_taken", 409);
  }
  await recordEvent(c, "team_registered", id, actor);
  return c.json({ id: playerId, passUrl: `/p/${id}#key=${token}` }, 201);
});

app.post("/api/tournaments/:id/start", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const tournament = await organizerTournament(c, id);
  if (tournament.status !== "registration") throw new ApiError("cannot_start", 409);
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM players WHERE tournament_id = ? AND checked_in = 1 AND dropped = 0",
  )
    .bind(id)
    .first<{ count: number }>();
  if ((count?.count ?? 0) < 3) throw new ApiError("not_enough_teams", 409);
  const scheduleSlots = await createSchedule(c.env.DB, tournament);
  if (scheduleSlots < 1) throw new ApiError("cannot_start", 409);
  const changed = await c.env.DB.prepare(
    "UPDATE tournaments SET status = 'active', current_round = ?, updated_at = ? WHERE id = ? AND status = 'registration'",
  )
    .bind(scheduleSlots, nowSeconds(), id)
    .run();
  if ((changed.meta.changes ?? 0) !== 1) throw new ApiError("cannot_start", 409);
  await recordEvent(c, "schedule_started", id, tournament.creator_session_id);
  return c.json({ scheduleSlots });
});

app.post("/api/tournaments/:id/matches/:matchId/report", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const matchId = validateId(c.req.param("matchId"));
  const tournament = await tournamentById(c.env.DB, id);
  if (tournament.status !== "active") throw new ApiError("reporting_closed", 409);
  const player = await participant(c, id);
  const match = await c.env.DB.prepare("SELECT * FROM matches WHERE id = ? AND tournament_id = ?")
    .bind(matchId, id)
    .first<MatchRow>();
  if (!match || (match.player1_id !== player.id && match.player2_id !== player.id)) {
    throw new ApiError("match_not_found", 404);
  }
  if (match.status === "confirmed") throw new ApiError("result_already_confirmed", 409);
  const payload = objectPayload(await parseJson(c, 1024));
  const homeScore = integerValue(payload, "homeScore", 0, 99);
  const awayScore = integerValue(payload, "awayScore", 0, 99);
  const score = `${homeScore}:${awayScore}`;
  const isFirst = match.player1_id === player.id;
  const column = isFirst ? "player1_report" : "player2_report";
  await c.env.DB.prepare(
    `UPDATE matches SET ${column} = ?, updated_at = ? WHERE id = ? AND status != 'confirmed'`,
  )
    .bind(score, nowSeconds(), matchId)
    .run();
  await recordEvent(c, "score_reported", id, player.session_id);
  const latest = await c.env.DB.prepare("SELECT * FROM matches WHERE id = ?")
    .bind(matchId)
    .first<MatchRow>();
  let status = latest?.status ?? "pending";
  if (latest?.player1_report && latest.player2_report) {
    const agreed = latest.player1_report === latest.player2_report;
    status = agreed ? "confirmed" : "disputed";
    const changed = await c.env.DB.prepare(
      `UPDATE matches SET status = ?, confirmed_result = ?, updated_at = ?
         WHERE id = ? AND status != 'confirmed'`,
    )
      .bind(status, agreed ? latest.player1_report : "", nowSeconds(), matchId)
      .run();
    if (agreed && (changed.meta.changes ?? 0) > 0) {
      await recordEvent(c, "result_confirmed", id, player.session_id);
      await finishIfReady(c, id);
    }
  }
  return c.json({ status });
});

app.post("/api/tournaments/:id/matches/:matchId/resolve", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const matchId = validateId(c.req.param("matchId"));
  const tournament = await organizerTournament(c, id);
  if (tournament.status !== "active") throw new ApiError("reporting_closed", 409);
  const payload = objectPayload(await parseJson(c, 1024));
  const homeScore = integerValue(payload, "homeScore", 0, 99);
  const awayScore = integerValue(payload, "awayScore", 0, 99);
  const score = `${homeScore}:${awayScore}`;
  const changed = await c.env.DB.prepare(
    `UPDATE matches
       SET confirmed_result = ?, status = 'confirmed', updated_at = ?
       WHERE id = ? AND tournament_id = ? AND status != 'confirmed'`,
  )
    .bind(score, nowSeconds(), matchId, id)
    .run();
  if ((changed.meta.changes ?? 0) !== 1) throw new ApiError("match_not_resolvable", 409);
  await recordEvent(c, "result_confirmed", id, tournament.creator_session_id);
  await finishIfReady(c, id);
  return c.json({ status: "confirmed" });
});

app.post("/api/tournaments/:id/drop", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  const tournament = await tournamentById(c.env.DB, id);
  const player = await participant(c, id);
  if (tournament.status !== "registration") throw new ApiError("cannot_drop", 409);
  await c.env.DB.prepare("UPDATE players SET dropped = 1, updated_at = ? WHERE id = ?")
    .bind(nowSeconds(), player.id)
    .run();
  return c.json({ dropped: true });
});

app.post("/api/tournaments/:id/report", async (c) => {
  enforceSameOrigin(c);
  const id = validateId(c.req.param("id"));
  await tournamentById(c.env.DB, id);
  const actor = sessionId(c);
  const payload = objectPayload(await parseJson(c, 1024));
  const reason = cleanText(payload, "reason", 12);
  if (!reportReasons.has(reason)) throw new ApiError("invalid_reason", 400);
  try {
    await c.env.DB.prepare(
      "INSERT INTO content_reports (tournament_id, session_id, reason, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(id, actor, reason, nowSeconds())
      .run();
  } catch {
    throw new ApiError("already_reported", 409);
  }
  const reports = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM content_reports WHERE tournament_id = ?",
  )
    .bind(id)
    .first<{ count: number }>();
  if ((reports?.count ?? 0) >= 3) {
    await c.env.DB.prepare("UPDATE tournaments SET status = 'hidden', updated_at = ? WHERE id = ?")
      .bind(nowSeconds(), id)
      .run();
  }
  return c.json({ accepted: true }, 202);
});

app.get("/api/tournaments/:id/snapshot.json", async (c) => {
  const id = validateId(c.req.param("id"));
  const tournament = await organizerTournament(c, id);
  const state = await publicState(c.env.DB, tournament);
  c.header("Content-Disposition", `attachment; filename="shiai-ban-${id.slice(0, 8)}.json"`);
  return c.json({ exportedAt: new Date().toISOString(), ...state });
});

app.get("/api/tournaments/:id/snapshot.csv", async (c) => {
  const id = validateId(c.req.param("id"));
  const tournament = await organizerTournament(c, id);
  const state = await publicState(c.env.DB, tournament);
  const escape = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
  const rows = [
    ["順位", "チーム", "試合", "勝", "分", "負", "得点", "失点", "得失点差", "勝点"],
    ...state.standings.map((standing) => [
      standing.rank,
      standing.name,
      standing.played,
      standing.wins,
      standing.draws,
      standing.losses,
      standing.goalsFor,
      standing.goalsAgainst,
      standing.goalDifference,
      standing.points,
    ]),
  ];
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="shiai-ban-${id.slice(0, 8)}.csv"`);
  return c.body(`\uFEFF${rows.map((row) => row.map(escape).join(",")).join("\r\n")}`);
});

app.get("/health", (c) => c.json({ ok: true }));

app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/") || !/\.[a-z0-9]{2,8}$/iu.test(c.req.path)) {
    return c.html(
      <Layout
        canonical="https://shiai-ban.yhay81.com/"
        description="指定された盤面は見つかりませんでした。"
        noindex
        title="見つかりません｜試合盤"
      >
        <main class="not-found">
          <span class="brand-mark large">試</span>
          <h1>盤面が見つかりません。</h1>
          <a class="primary button-link" href="/">
            ホームへ
          </a>
        </main>
      </Layout>,
      404,
    );
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  if (error instanceof ApiError) {
    return c.json({ error: error.code, requestId: c.get("requestId") }, error.status);
  }
  console.error("unhandled_error", {
    message: error instanceof Error ? error.message : String(error),
    requestId: c.get("requestId"),
  });
  return c.json({ error: "internal_error", requestId: c.get("requestId") }, 500);
});

const scheduled: ExportedHandlerScheduledHandler<Bindings> = async (_event, env) => {
  const timestamp = nowSeconds();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM tournaments WHERE expires_at <= ?").bind(timestamp),
    env.DB.prepare("DELETE FROM product_events WHERE created_at <= ?").bind(timestamp - 45 * 86400),
  ]);
};

export { app, scheduled, statusLabel };

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Bindings>;
