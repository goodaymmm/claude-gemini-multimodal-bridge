// Test fixture: writes a multi-byte UTF-8 character split across two writes.
//
// Decoding each Buffer chunk independently turns the split character into two
// U+FFFD replacements, so a Japanese answer comes back quietly corrupted.
const text = Buffer.from('日本語テスト応答', 'utf8');
const cut = 4; // lands inside a 3-byte character
process.stdout.write(text.subarray(0, cut));
setTimeout(() => {
  process.stdout.write(text.subarray(cut));
  process.stdout.write('\n');
}, 30);
