const fs = require('fs');
let code = fs.readFileSync('components/AgentChat.tsx', 'utf8');

code = code.replace(/\{chatMode === 'voice' && \(\s*<div className=\{`wai-voice-panel\$\{mobileTab === 'chat' \? ' wai-mobile-active' : ''\}`\}>/g, 
  "{chatMode === 'voice' && (\n              <div className={`wai-panel wai-panel-left wai-voice-panel${mobileTab === 'chat' ? ' wai-mobile-active' : ''}`>}");

// Let's do it safer component by component
code = code.replace(/className=\{`wai-voice-panel\$\{mobileTab/g, "className={`wai-panel wai-panel-left wai-voice-panel${mobileTab");
code = code.replace(/className=\{`wai-chat\$\{mobileTab/g, "className={`wai-panel wai-panel-left wai-chat${mobileTab");
code = code.replace(/className=\{`wai-products\$\{mobileTab/g, "className={`wai-panel wai-panel-right wai-products${mobileTab");
code = code.replace(/className="wai-offers-fullscreen"/g, 'className="wai-panel wai-panel-full wai-offers-fullscreen"');

fs.writeFileSync('components/AgentChat.tsx', code);
console.log('Updated AgentChat.tsx');
