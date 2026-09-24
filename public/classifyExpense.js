// Shared by the sample experience and server parser. Match words and phrases,
// never substrings: “tea” should not turn “steam cleaner” into a cafe purchase.
const CATEGORY_NAMES = new Set(['food_drink', 'shopping', 'entertainment', 'transport', 'groceries', 'bills', 'health', 'other']);
const ALIASES = Object.freeze({
  cofee: 'coffee', coffe: 'coffee', cofffee: 'coffee', coffeey: 'coffee',
  capuccino: 'cappuccino', cappucino: 'cappuccino', resturant: 'restaurant',
  restaurent: 'restaurant', restrant: 'restaurant', biriyani: 'biryani', biryanni: 'biryani',
  idly: 'idli', idlys: 'idlis', dosai: 'dosa', dosas: 'dosa',
  swigy: 'swiggy', swiggyy: 'swiggy', zomto: 'zomato', zomatoo: 'zomato',
  grocries: 'groceries', grocerries: 'groceries', grocerys: 'groceries', grocerry: 'grocery',
  vegitables: 'vegetables', vegtables: 'vegetables', veggies: 'vegetables',
  petorl: 'petrol', pertrol: 'petrol',
  medcine: 'medicine', medicne: 'medicine', medicines: 'medicine', medecine: 'medicine',
  pharamacy: 'pharmacy', pharmacyy: 'pharmacy', eletricity: 'electricity',
  electrcity: 'electricity', rechrge: 'recharge',
  shoping: 'shopping', shoppng: 'shopping', netfilx: 'netflix', spotfy: 'spotify',
});

const WORDS = {
  food_drink: new Set('food coffee chai tea dosa idli idlis vada wada biryani biriani poha upma paratha samosa kachori chaat panipuri puri momos maggi noodles pizza burger sandwich fries snacks snack chips chocolate icecream cake pastry pastries juice soda cola cafe café cafeteria restaurant takeaway takeout swiggy zomato meal meals breakfast lunch dinner brunch cappuccino latte espresso popcorn tiffin'.split(' ')),
  groceries: new Set('grocery groceries vegetable vegetables fruit fruits milk rice dal atta flour lentils bread eggs butter curd yogurt paneer cereal pulses produce supermarket bigbasket blinkit zepto instamart dmart kirana'.split(' ')),
  transport: new Set('uber ola rapido auto autorickshaw rickshaw taxi cab cabs bus train metro petrol diesel fuel commute commuting toll tolls parking airfare flight flights ferry'.split(' ')),
  health: new Set('medicine medication medicines pharmacy chemist doctor hospital clinic dentist dental medical prescription prescriptions consultation physiotherapy vaccination vaccine'.split(' ')),
  shopping: new Set('shopping shirt shirts tshirt tshirts clothes clothing dress dresses jeans trousers pants shoes shoe sneakers sandals footwear socks jacket saree kurta headphones charger furniture makeup cosmetics'.split(' ')),
  entertainment: new Set('netflix spotify cinema movie movies game games gaming videogame videogames concert concerts theatre theater hotstar disney primevideo youtube bowling arcade'.split(' ')),
};
const BILLS = new Set('rent electricity utilities utility broadband wifi internet recharge insurance emi lpg'.split(' '));

function normalizedWords(value) {
  if (typeof value !== 'string') return [];
  return value.normalize('NFKC').toLowerCase().replace(/t-shirts?/g, 'tshirt')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean)
    .map((word) => ALIASES[word] || word);
}

/** Retain the model's nuance unless the user actually changes the category. */
export function potentialLeakForCategory(category, previousCategory, previousFlag) {
  if (category === previousCategory) return previousFlag === true;
  return ['food_drink', 'shopping', 'entertainment'].includes(category);
}

/** Only explicit, unambiguous category cues are considered a match. */
export function inferCategory(value) {
  const words = normalizedWords(value);
  const tokens = new Set(words);
  const text = ` ${words.join(' ')} `;
  const result = (category) => ({ category, is_potential_leak: potentialLeakForCategory(category), matched: category !== 'other' });
  const has = (set) => words.some((word) => set.has(word));
  const phrase = (pattern) => pattern.test(text);

  // The deterministic fallback cannot reliably interpret negated purchases.
  if (['not', 'never', 'without', 'refund', 'refunded', 'reimbursement'].some((word) => tokens.has(word))) return result('other');

  // The purpose of a bill wins over an incidental merchant or payment label.
  if (has(BILLS) || phrase(/\b(?:water bill|gas bill|phone bill|mobile bill|electric bill|gas cylinder|wi fi|broad band|mobile plan|phone plan)\b/)) return result('bills');

  // “Tea powder” and “coffee beans” describe supplies, not a prepared drink.
  const contextualWords = text
    .replace(/\b(?:coffee (?:beans|powder)|tea (?:leaves|powder|bags)|cooking oil|grocery shopping|grocery delivery|food supplies|household supplies)\b/g, 'groceries')
    .replace(/\b(?:milk tea|milk shake|milkshake|milk coffee|ice cream|food delivery|eating out)\b/g, 'meal')
    .trim().split(/\s+/);
  const candidates = new Set();
  for (const [category, vocabulary] of Object.entries(WORDS)) {
    if (contextualWords.some((word) => vocabulary.has(word))) candidates.add(category);
  }
  if (phrase(/\bamazon prime\b/)) candidates.add('entertainment');
  if (candidates.size === 0 && (tokens.has('bill') || tokens.has('bills'))) return result('bills');
  if (candidates.size !== 1) return result('other');
  const category = [...candidates][0];
  return result(CATEGORY_NAMES.has(category) ? category : 'other');
}
