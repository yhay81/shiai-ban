const root = document.querySelector("[data-page]");
const page = root?.dataset.page;
const tournamentId = root?.dataset.id;
const key = new URLSearchParams(location.hash.slice(1)).get("key") ?? "";
const sessionStorageKey = "shiai-ban-session";
let state = null;

const getSession = () => {
  let value = localStorage.getItem(sessionStorageKey);
  if (!value) {
    value = crypto.randomUUID();
    localStorage.setItem(sessionStorageKey, value);
  }
  return value;
};

const labels = {
  active: "進行中",
  cancelled: "中止",
  completed: "終了",
  hidden: "非表示",
  registration: "受付中",
};

const errorLabels = {
  already_registered_or_name_taken: "この端末は登録済みか、そのチーム名は使われています。",
  cannot_drop: "日程作成後はチーム札から取り消せません。主催者へ伝えてください。",
  contact_not_allowed_in_displayName: "チーム名に連絡先やURLは入力できません。",
  invalid_capability: "札の鍵を確認できません。この端末に保存したURLから開いてください。",
  not_enough_teams: "日程作成には3チーム以上が必要です。",
  result_already_confirmed: "この得点は確定済みです。",
  tournament_full: "チーム上限に達しました。",
};

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const button = (text, className, action) => {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
};

const showAlert = (message) => {
  const alert = document.querySelector("[data-alert]");
  if (!(alert instanceof HTMLElement)) return;
  alert.textContent = message;
  alert.hidden = !message;
};

const request = async (path, options = {}) => {
  const headers = {
    ...(options.body ? { "content-type": "application/json" } : {}),
    "x-shiai-session": getSession(),
    ...(key ? { "x-shiai-key": key } : {}),
    ...options.headers,
  };
  const response = await fetch(path, { ...options, headers });
  const type = response.headers.get("content-type") ?? "";
  const body = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const code = typeof body === "object" && body ? body.error : "unknown";
    throw new Error(code);
  }
  return body;
};

const endpoint = () =>
  page === "manage"
    ? `/api/tournaments/${tournamentId}/manage`
    : page === "pass"
      ? `/api/tournaments/${tournamentId}/pass`
      : `/api/tournaments/${tournamentId}`;

const formatTime = (seconds) =>
  new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(
    new Date(seconds * 1000),
  );

const formatDateTime = (seconds) =>
  new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(seconds * 1000),
  );

const scoreForm = (match, action, label) => {
  const form = el("form", "score-form");
  const heading = el("span", "score-label", label);
  const home = el("input");
  home.type = "number";
  home.min = "0";
  home.max = "99";
  home.inputMode = "numeric";
  home.setAttribute("aria-label", `${match.home}の得点`);
  const colon = el("b", "score-colon", ":");
  const away = el("input");
  away.type = "number";
  away.min = "0";
  away.max = "99";
  away.inputMode = "numeric";
  away.setAttribute("aria-label", `${match.away}の得点`);
  const submit = el("button", "secondary", "確定");
  submit.type = "submit";
  form.append(heading, home, colon, away, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const homeScore = Number(home.value);
    const awayScore = Number(away.value);
    if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) return;
    action(homeScore, awayScore);
  });
  return form;
};

const createSlip = (match) => {
  const wrapper = el("div", "match-wrap");
  const slip = el("article", `table-slip ${match.status}`);
  const head = el("div", "match-head");
  head.append(el("time", "", formatTime(match.scheduledAt)));
  head.append(el("span", "pitch-badge", `PITCH ${match.pitchNumber}`));
  slip.append(head);
  const score = el("div", "match-score");
  score.append(el("div", "player-card", match.home));
  score.append(
    el("strong", "score-value", match.score ? match.score.replace(":", " : ") : "― : ―"),
  );
  score.append(el("div", "player-card", match.away));
  slip.append(score);
  const status =
    match.status === "disputed"
      ? "申告不一致"
      : match.status === "confirmed"
        ? "確認済み"
        : "得点待ち";
  slip.append(el("span", `match-status ${match.status}`, status));
  wrapper.append(slip);

  if (
    page === "pass" &&
    state.participant?.match?.id === match.id &&
    match.status !== "confirmed"
  ) {
    wrapper.append(
      scoreForm(
        match,
        (homeScore, awayScore) => reportScore(match.id, homeScore, awayScore),
        "チーム申告",
      ),
    );
  }
  if (page === "manage" && match.status !== "confirmed") {
    wrapper.append(
      scoreForm(
        match,
        (homeScore, awayScore) => resolve(match.id, homeScore, awayScore),
        match.status === "disputed" ? "主催確認" : "主催入力",
      ),
    );
  }
  return wrapper;
};

const renderSchedule = () => {
  const panel = document.querySelector('[data-panel="pairings"]');
  if (!(panel instanceof HTMLElement)) return;
  panel.replaceChildren();
  if (state.matches.length === 0) {
    const empty = el("div", "empty-board");
    empty.append(el("b", "", "チーム受付中"));
    empty.append(el("span", "", "3チーム以上そろうと、主催者が全試合を並べられます。"));
    panel.append(empty);
    return;
  }
  const groups = new Map();
  state.matches.forEach((match) => {
    const items = groups.get(match.slotNumber) ?? [];
    items.push(match);
    groups.set(match.slotNumber, items);
  });
  groups.forEach((matches, slotNumber) => {
    const section = el(
      "section",
      `slot-group${slotNumber === state.tournament.nextSlot ? " current" : ""}`,
    );
    const heading = el("div", "round-heading");
    heading.append(el("h2", "", `第${slotNumber}試合枠`));
    heading.append(el("span", "", formatTime(matches[0].scheduledAt)));
    section.append(heading);
    const list = el("div", "board-table-list");
    matches.forEach((match) => list.append(createSlip(match)));
    section.append(list);
    panel.append(section);
  });
};

const renderStandings = () => {
  const panel = document.querySelector('[data-panel="standings"]');
  if (!(panel instanceof HTMLElement)) return;
  panel.replaceChildren();
  const table = el("table", "standings");
  const head = el("thead");
  const headRow = el("tr");
  ["順位", "チーム", "試", "勝", "分", "負", "得失", "勝点"].forEach((label) =>
    headRow.append(el("th", "", label)),
  );
  head.append(headRow);
  const body = el("tbody");
  state.standings.forEach((standing) => {
    const row = el("tr");
    [
      standing.rank,
      standing.name,
      standing.played,
      standing.wins,
      standing.draws,
      standing.losses,
      standing.goalDifference > 0 ? `+${standing.goalDifference}` : standing.goalDifference,
      standing.points,
    ].forEach((value, index) => row.append(el("td", index === 0 ? "rank" : "", String(value))));
    body.append(row);
  });
  table.append(head, body);
  panel.append(table);
};

const renderTeams = () => {
  const panel = document.querySelector('[data-panel="players"]');
  if (!(panel instanceof HTMLElement)) return;
  panel.replaceChildren();
  const grid = el("div", "player-grid");
  state.players.forEach((player) => {
    const chip = el("div", `player-chip${player.dropped ? " dropped" : " checked"}`);
    chip.append(el("i"));
    chip.append(el("span", "", player.displayName));
    grid.append(chip);
  });
  panel.append(grid);
};

const registrationPanel = () => {
  const card = el("section", "mode-card");
  const copy = el("div");
  copy.append(el("strong", "", `${state.players.length} / ${state.tournament.maxTeams} チーム`));
  copy.append(el("p", "", "選手名や連絡先を入れず、チーム名だけで札を受け取ります。"));
  card.append(copy);
  const storedPass = localStorage.getItem(`shiai-ban-pass-${tournamentId}`);
  if (storedPass) {
    const link = el("a", "primary button-link", "自分のチーム札をひらく");
    link.href = storedPass;
    card.append(link);
  } else if (state.tournament.status === "registration") {
    const form = el("form", "registration-form");
    const label = el("label", "", "チーム名");
    const input = el("input");
    input.name = "displayName";
    input.maxLength = 32;
    input.required = true;
    label.append(input);
    const submit = el("button", "primary", "チーム札を受け取る");
    submit.type = "submit";
    const errorBox = el("p", "form-error");
    form.append(label, submit, errorBox);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      errorBox.textContent = "";
      try {
        const result = await request(`/api/tournaments/${tournamentId}/register`, {
          body: JSON.stringify({ displayName: input.value, website: "" }),
          method: "POST",
        });
        localStorage.setItem(`shiai-ban-pass-${tournamentId}`, result.passUrl);
        location.assign(result.passUrl);
      } catch (error) {
        const code = error instanceof Error ? error.message : "unknown";
        errorBox.textContent = errorLabels[code] ?? "登録できませんでした。";
      } finally {
        submit.disabled = false;
      }
    });
    card.append(form);
  }
  return card;
};

const managerPanel = () => {
  const card = el("section", "mode-card");
  const copy = el("div");
  copy.append(
    el(
      "strong",
      "",
      `主催盤面 · ${state.players.filter((player) => !player.dropped).length} チーム`,
    ),
  );
  copy.append(
    el(
      "p",
      "",
      state.tournament.status === "registration"
        ? "3チーム以上そろったら、全試合を並べます。"
        : `${state.tournament.scheduleSlots}試合枠を進行中`,
    ),
  );
  card.append(copy);
  const actions = el("div", "mode-actions");
  if (state.tournament.status === "registration")
    actions.append(button("全試合を並べる", "primary", startTournament));
  actions.append(button("公開URLをコピー", "secondary", copyPublicUrl));
  actions.append(button("印刷", "secondary", () => window.print()));
  actions.append(button("JSON控え", "secondary", () => downloadSnapshot("json")));
  actions.append(button("CSV順位", "secondary", () => downloadSnapshot("csv")));
  card.append(actions);
  return card;
};

const passPanel = () => {
  const card = el("section", "mode-card");
  const copy = el("div");
  copy.append(el("strong", "", `${state.participant.displayName} のチーム札`));
  const next = state.participant.match
    ? state.matches.find((match) => match.id === state.participant.match.id)
    : null;
  copy.append(
    el(
      "p",
      "",
      next
        ? `次は ${formatTime(next.scheduledAt)}・PITCH ${next.pitchNumber}`
        : state.tournament.status === "registration"
          ? "日程が並ぶまでお待ちください。"
          : "確認待ちの試合はありません。",
    ),
  );
  card.append(copy);
  if (!state.participant.dropped && state.tournament.status === "registration") {
    const actions = el("div", "mode-actions");
    actions.append(button("登録を取り消す", "danger", drop));
    card.append(actions);
  }
  return card;
};

const render = () => {
  document.querySelector(".board-loading")?.remove();
  const app = document.querySelector("[data-board-app]");
  if (!(app instanceof HTMLElement)) return;
  app.hidden = false;
  const assign = (selector, value) => {
    const node = document.querySelector(selector);
    if (node) node.textContent = value;
  };
  assign("[data-sport]", state.tournament.sportLabel);
  assign("[data-title]", state.tournament.title);
  assign("[data-start]", formatDateTime(state.tournament.startsAt));
  assign("[data-venue]", state.tournament.venue);
  assign("[data-status]", labels[state.tournament.status] ?? state.tournament.status);
  const panel = document.querySelector("[data-mode-panel]");
  if (panel)
    panel.replaceChildren(
      page === "manage" ? managerPanel() : page === "pass" ? passPanel() : registrationPanel(),
    );
  renderSchedule();
  renderStandings();
  renderTeams();
};

const load = async (quiet = false) => {
  try {
    state = await request(endpoint());
    render();
    if (!quiet) showAlert("");
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    showAlert(errorLabels[code] ?? "盤面を読み込めませんでした。URLと通信状態を確認してください。");
  }
};

const perform = async (path, body) => {
  showAlert("");
  try {
    await request(path, { body: body ? JSON.stringify(body) : undefined, method: "POST" });
    await load();
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    showAlert(errorLabels[code] ?? "操作を完了できませんでした。盤面を更新して確認してください。");
  }
};

const startTournament = () => perform(`/api/tournaments/${tournamentId}/start`);
const reportScore = (matchId, homeScore, awayScore) =>
  perform(`/api/tournaments/${tournamentId}/matches/${matchId}/report`, { awayScore, homeScore });
const resolve = (matchId, homeScore, awayScore) =>
  perform(`/api/tournaments/${tournamentId}/matches/${matchId}/resolve`, { awayScore, homeScore });
const drop = () => {
  if (confirm("このチームの登録を取り消しますか？"))
    void perform(`/api/tournaments/${tournamentId}/drop`);
};

const copyPublicUrl = async () => {
  try {
    await navigator.clipboard.writeText(`${location.origin}/t/${tournamentId}`);
    showAlert("公開URLをコピーしました。");
  } catch {
    showAlert("公開URLをコピーできませんでした。");
  }
};

const downloadSnapshot = async (format) => {
  try {
    const response = await fetch(`/api/tournaments/${tournamentId}/snapshot.${format}`, {
      headers: { "x-shiai-key": key, "x-shiai-session": getSession() },
    });
    if (!response.ok) throw new Error("download_failed");
    const blob = await response.blob();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `shiai-ban-${tournamentId.slice(0, 8)}.${format}`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch {
    showAlert("控えを保存できませんでした。");
  }
};

document.querySelectorAll("[data-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    const name = tab.dataset.tab;
    document
      .querySelectorAll("[data-tab]")
      .forEach((candidate) => candidate.classList.toggle("active", candidate === tab));
    document.querySelectorAll("[data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== name;
    });
  });
});

if ((page === "manage" || page === "pass") && !key) {
  showAlert("この札には鍵がありません。最初に保存したURLから開いてください。");
} else {
  void load();
  if (page === "event" && !sessionStorage.getItem(`shiai-ban-viewed-${tournamentId}`)) {
    sessionStorage.setItem(`shiai-ban-viewed-${tournamentId}`, "1");
    void request("/api/events", {
      body: JSON.stringify({ name: "public_board_viewed", tournamentId }),
      method: "POST",
    }).catch(() => undefined);
  }
  setInterval(() => void load(true), 15000);
}
