const fs = require('fs');
const code = fs.readFileSync('components/AgentChat.tsx', 'utf8');

// Match all <style>{`...`}</style> blocks
const regex = /<style>\{`([\s\S]*?)`\}<\/style>/g;
let match;
let allCss = '';

while ((match = regex.exec(code)) !== null) {
  allCss += match[1] + '\n\n';
}

if (allCss) {
  // Save the full CSS
  fs.writeFileSync('components/AgentChatWidget.css', allCss);
  console.log('Extracted ' + allCss.split('\n').length + ' lines of CSS');
  
  // Remove the <style>{`...`}</style> blocks from AgentChat.tsx
  let updatedCode = code.replace(/\{?\/\*\s*══\s*(Landing page styles|Styles)\s*══\s*\*\/\s*\}?\s*<style>\{`[\s\S]*?`\}<\/style>/g, '');
  // Also catch unaccompanied <style> blocks if they exist without the comment
  updatedCode = updatedCode.replace(/<style>\{`[\s\S]*?`\}<\/style>/g, '');
  
  // Add CSS import at the top of the file
  if (!updatedCode.includes("import './AgentChatWidget.css'")) {
    updatedCode = updatedCode.replace(/'use client';/, "'use client';\nimport './AgentChatWidget.css';");
    updatedCode = updatedCode.replace(/"use client";/, '"use client";\nimport "./AgentChatWidget.css";');
  }
  
  fs.writeFileSync('components/AgentChat.tsx', updatedCode);
  console.log('Updated AgentChat.tsx');
} else {
  console.log('No match found');
}
