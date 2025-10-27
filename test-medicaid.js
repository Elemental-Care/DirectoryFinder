const { searchIllinoisMedicaid } = require('./scripts/il-medicaid-search');
(async () => {
  const result = await searchIllinoisMedicaid('1346613718', { headless: true });
  console.log(JSON.stringify(result, null, 2));
})();
