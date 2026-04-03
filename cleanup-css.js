const fs = require('fs');
let css = fs.readFileSync('components/AgentChatWidget.css', 'utf8');

// The new clean CSS to inject after .wai-panels
const structuredCss = `
          /* ── Base Panel Layout ──────────────────────── */
          .wai-panel {
            min-height: 0;
            overflow: hidden;
            display: flex;
            flex-direction: column;
          }
          
          .wai-panel-left {
            width: 45%;
            min-width: 260px;
            border-right: 1px solid rgba(192,57,43,0.06);
            flex-shrink: 0;
          }
          
          .wai-panel-right {
            flex: 1;
            min-width: 0;
          }

          .wai-panel-full {
            flex: 1;
            min-width: 0;
          }
`;

// Insert the structured CSS after `.wai-panels { ... }`
css = css.replace(/(\.wai-panels\s*\{[^}]+\})/, '$1\n' + structuredCss);

// Now, replace the messy media queries with the cleaner ones
const oldMobileMediaQueriesRegex = /\/\* Hide both panels by default on mobile, show only active \*\/[\s\S]*?(?=\/\* Voice panel: comfortable mic zone on mobile \*\/)/;

const newMobileMediaQueries = `/* Hide both panels by default on mobile, show only active */
            .wai-panel-left, .wai-panel-right {
              width: 100% !important; 
              max-width: 100% !important; 
              min-width: unset !important;
              border-right: none !important;
              display: none !important;
              flex: 1 1 auto;
              min-height: 0; 
            }
            .wai-panel-full {
              width: 100% !important;
              flex: 1 1 auto;
              min-height: 0;
            }
            .wai-panel.wai-mobile-active {
              display: flex !important;
            }

            `;

if (oldMobileMediaQueriesRegex.test(css)) {
  css = css.replace(oldMobileMediaQueriesRegex, newMobileMediaQueries);
} else {
  // If it fails to find the exact comment block, append to the end.
  css += "\n@media (max-width: 640px) {\n" + newMobileMediaQueries + "}\n";
}

fs.writeFileSync('components/AgentChatWidget.css', css);
console.log('Cleaned up AgentChatWidget.css');
