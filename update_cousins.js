const fs = require('fs');

// Read the database
const db = JSON.parse(fs.readFileSync('./arenabots.db.json', 'utf8'));

// Update James (ID: 1)
db.entitlements['1'].pro_until = '2099-12-31T23:59:59.999Z'; // Lifetime pro
db.entitlements['1'].pro_plan = 'exclusive';
db.entitlements['1'].crowns = 10000; // Give them lots of crowns

// Update leonidas (ID: 2)
db.entitlements['2'].pro_until = '2099-12-31T23:59:59.999Z'; // Lifetime pro
db.entitlements['2'].pro_plan = 'exclusive';
db.entitlements['2'].crowns = 10000; // Give them lots of crowns

// Update theseus (ID: 3)
db.entitlements['3'].pro_until = '2099-12-31T23:59:59.999Z'; // Lifetime pro
db.entitlements['3'].pro_plan = 'exclusive';
db.entitlements['3'].crowns = 10000; // Give them lots of crowns

// Write back
fs.writeFileSync('./arenabots.db.json.updated', JSON.stringify(db, null, 2));
console.log('Database updated successfully');
console.log('James, Leonidas and Theseus now have lifetime pro with 10000 crowns each');
