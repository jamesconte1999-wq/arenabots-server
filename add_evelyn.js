// Script to create exclusive full unlocked account for evelyn
const bcrypt = require('bcryptjs');
const db = require('./src/db/db');

const username = 'evelyn';
const password = 'evelyn123'; // You can change this
const displayName = 'Evelyn';

async function main() {
  try {
    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Create account
    const accountId = db.createAccount(username, passwordHash, displayName);
    console.log(`Created account for ${username} with ID: ${accountId}`);
    
    // Set exclusive pro entitlements
    db.setProUntil(accountId, 'lifetime', 'exclusive');
    console.log(`Set lifetime exclusive pro for account ${accountId}`);
    
    // Add crowns
    db.addCrowns(accountId, 10000);
    console.log(`Added 10000 crowns to account ${accountId}`);
    
    // Set high stats for full unlocked experience
    db.saveStats(accountId, {
      xp: 100000,
      level: 32,
      rank_points: 10000,
      wins: 500,
      losses: 50,
      kills: 5000,
      matches_played: 550,
      streak_current: 10,
      streak_best: 50
    });
    console.log(`Set max stats for account ${accountId}`);
    
    console.log('\n=== Account Created ===');
    console.log(`Username: ${username}`);
    console.log(`Password: ${password}`);
    console.log(`Account ID: ${accountId}`);
    console.log(`Pro Plan: exclusive (lifetime)`);
    console.log(`Crowns: 10000`);
    console.log(`Level: 32`);
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();
