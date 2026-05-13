// Script to reset leonidas password
const bcrypt = require('bcryptjs');
const db = require('./src/db/db');

const username = 'leonidas';
const newPassword = 'leonidas123';

async function main() {
  try {
    // Find account
    const account = db.findByUsername(username);
    if (!account) {
      console.error(`Account ${username} not found`);
      process.exit(1);
    }
    
    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 10);
    
    // Update password in database
    const fs = require('fs');
    const path = require('path');
    
    const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'arenabots.db.json');
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    
    data.accounts[account.id].password_hash = passwordHash;
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
    
    console.log(`Password reset for ${username}`);
    console.log(`New password: ${newPassword}`);
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
