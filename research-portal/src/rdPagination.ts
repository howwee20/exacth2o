import type { RdCorrectionEpisode, RdLabSnapshot } from "./rdTypes";

function mergeEpisodes(
  current: RdCorrectionEpisode[] = [],
  incoming: RdCorrectionEpisode[] = [],
) {
  const byId = new Map(current.map((episode) => [episode.id, episode]));
  for (const episode of incoming) byId.set(episode.id, episode);
  return [...byId.values()].sort(
    (left, right) => Date.parse(right.started_at) - Date.parse(left.started_at),
  );
}

export function mergeRdHistoryPage(
  current: RdLabSnapshot,
  page: RdLabSnapshot,
): RdLabSnapshot {
  const pagePots = new Map(page.pots.map((pot) => [pot.pairing_name, pot]));
  return {
    ...current,
    episodes: mergeEpisodes(current.episodes, page.episodes),
    pagination: page.pagination,
    pots: current.pots.map((pot) => ({
      ...pot,
      episodes: mergeEpisodes(
        pot.episodes,
        pagePots.get(pot.pairing_name)?.episodes,
      ),
    })),
  };
}
