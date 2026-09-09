// A light "wants" system, Sims-whims style. Each critter gets one persistent
// aspiration (flavour + a skill it leans toward) at creation, and a rotating
// small whim — a single concrete, achievable goal tied to one action — that
// refreshes whenever it's completed or goes stale. It's deliberately shallow:
// no quest chains, just "here's a nice thing to do next" with a payoff when
// the critter (or the player, via a suggestion) follows through.

export const ASPIRATIONS = [
  { id: 'gourmet',   label: 'Gourmet',         icon: '🍳', skill: 'cooking',   flavor: 'wants to cook something great' },
  { id: 'athlete',   label: 'Athlete',         icon: '🏃', skill: 'fitness',   flavor: 'wants to stay active' },
  { id: 'bookworm',  label: 'Bookworm',        icon: '📖', skill: 'creativity',flavor: 'wants a quiet corner and a good book' },
  { id: 'social',    label: 'Social Butterfly',icon: '💬', skill: 'charisma',  flavor: 'wants to know everyone in the house' },
  { id: 'neat',      label: 'Neat Freak',      icon: '🧹', skill: null,        flavor: 'wants everything spotless' },
];

/** id -> { label, icon, actionId, weight: {aspirationId: multiplier} } */
export const WHIM_POOL = [
  { id: 'cook_meal',   label: 'cook a meal',        icon: '🍳', actionId: 'cook',          weight: { gourmet: 4 } },
  { id: 'eat_well',    label: 'eat a proper meal',  icon: '🍽️', actionId: 'eat_at',        weight: { gourmet: 2 } },
  { id: 'play_ball',   label: 'play with the ball', icon: '⚽', actionId: 'play_ball',      weight: { athlete: 4 } },
  { id: 'dance_a_bit', label: 'dance a little',     icon: '🕺', actionId: 'dance',          weight: { athlete: 2, social: 3 } },
  { id: 'read_book',   label: 'read something',     icon: '📖', actionId: 'read',          weight: { bookworm: 4 } },
  { id: 'craft_thing', label: 'craft something',    icon: '🔨', actionId: 'craft',         weight: { bookworm: 3 } },
  { id: 'roll_dice',   label: 'roll the dice',      icon: '🎲', actionId: 'roll_dice',      weight: { bookworm: 1 } },
  { id: 'make_friend', label: 'spend time with someone', icon: '💗', actionId: 'socialize', weight: { social: 4 } },
  { id: 'tidy_up',     label: 'tidy up the house',  icon: '🧹', actionId: 'clean_up',       weight: { neat: 4 } },
  { id: 'wash_up',     label: 'wash up',            icon: '💧', actionId: 'wash_up',        weight: { neat: 2 } },
  { id: 'water_plant', label: 'water a plant',      icon: '🪴', actionId: 'water_plant',    weight: { neat: 1 } },
  { id: 'see_outside', label: 'go see outside',     icon: '🗺️', actionId: 'explore_outside', weight: {} },
  { id: 'get_coffee',  label: 'grab a coffee',      icon: '☕', actionId: 'brew_coffee',    weight: {} },
];

export function pickAspiration(rng) {
  return ASPIRATIONS[rng.int(0, ASPIRATIONS.length - 1)];
}

/** Weighted toward the critter's aspiration, but never exclusively — a
 *  bookworm still gets asked to play ball sometimes. */
export function rollWhim(rng, aspirationId, excludeId) {
  const pool = WHIM_POOL.filter((w) => w.id !== excludeId);
  const weights = pool.map((w) => 1 + (w.weight[aspirationId] || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}
