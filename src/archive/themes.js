/**
 * Themes for the Sunday archive post. A photo matches a theme when any
 * keyword is a substring of one of its Russian tags. `phrase` completes
 * "Архивное: дедушки ..." in the fallback caption.
 */
export const ARCHIVE_THEMES = [
  { key: "walk", phrase: "на прогулке", keywords: ["идёт", "прогулк"] },
  { key: "caps", phrase: "в кепках", keywords: ["кепк", "бейсболк"] },
  { key: "glasses", phrase: "в очках", keywords: ["очки"] },
  { key: "bench", phrase: "на скамейках", keywords: ["скамейк"] },
  { key: "park", phrase: "в парке", keywords: ["парк", "газон"] },
  { key: "metro", phrase: "в метро", keywords: ["метро"] },
  { key: "plaid", phrase: "в клетчатых рубашках", keywords: ["клетчат"] },
  { key: "cane", phrase: "с тростью", keywords: ["трост"] },
  { key: "backpack", phrase: "с рюкзаками", keywords: ["рюкзак"] },
  { key: "shorts", phrase: "в шортах", keywords: ["шорты"] },
  { key: "shop", phrase: "в магазинах", keywords: ["магазин", "супермаркет"] },
  { key: "rain", phrase: "под дождём", keywords: ["дождь", "зонт"] },
  { key: "evening", phrase: "вечером", keywords: ["вечер", "ночь"] },
  { key: "bus", phrase: "в транспорте", keywords: ["автобус", "пассажир", "трамвай"] },
  { key: "scarf", phrase: "в шарфах", keywords: ["шарф"] },
  { key: "jeans", phrase: "в джинсах", keywords: ["джинс"] },
  { key: "sneakers", phrase: "в кроссовках", keywords: ["кроссовк"] },
  { key: "bags", phrase: "с сумками и пакетами", keywords: ["сумк", "пакет"] },
  { key: "cafe", phrase: "в кафе", keywords: ["кафе"] },
  { key: "winter", phrase: "зимой", keywords: ["снег", "зима", "зимн", "пуховик"] },
  { key: "mask", phrase: "в масках", keywords: ["маск"] },
  { key: "watch", phrase: "с часами", keywords: ["часы"] },
];

/** Minimum matching photos for a theme to be usable. */
export const MIN_THEME_PHOTOS = 6;

/** @param {{ tags: string[] }} photo */
export function photoMatchesTheme(photo, theme) {
  return photo.tags.some((t) => theme.keywords.some((k) => t.includes(k)));
}
