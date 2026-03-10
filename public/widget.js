/**
 * Embeddable Chat Widget
 * Supports floating and inline modes
 */
(function () {
  'use strict';

  // Prevent multiple initializations
  if (window.__AI_AGENT_WIDGET_INITIALIZED__) {
    console.warn('Chat widget: Widget already initialized, skipping...');
  } else {
    window.__AI_AGENT_WIDGET_INITIALIZED__ = true;

    // Wait for DOM to be ready
    function initWidget() {
      // Get script element to read data attributes
      // Try multiple methods to find the script
      let script = document.currentScript;

      // If currentScript is null (async/defer), find by data attributes
      if (!script) {
        const scripts = document.querySelectorAll('script[data-agent-id]');
        // Get the last one (most recently added) that hasn't been processed
        for (let i = scripts.length - 1; i >= 0; i--) {
          if (!scripts[i].dataset.processed) {
            script = scripts[i];
            scripts[i].dataset.processed = 'true';
            break;
          }
        }
      } else {
        script.dataset.processed = 'true';
      }

      if (!script) {
        console.error('Chat widget: Could not find script element. Make sure the script tag has data-agent-id attribute.');
        return;
      }

      const agentId = script.getAttribute('data-agent-id');
      const type = script.getAttribute('data-type') || 'floating';
      const target = script.getAttribute('data-target');

      // Get base URL from script src or data attribute
      let baseUrl = script.getAttribute('data-base-url');
      if (!baseUrl) {
        // Try to get from script src
        const scriptSrc = script.src;
        if (scriptSrc) {
          try {
            const url = new URL(scriptSrc);
            baseUrl = url.origin;
          } catch (e) {
            // Fallback to current origin (might not work for cross-domain)
            baseUrl = window.location.origin;
          }
        } else {
          baseUrl = window.location.origin;
        }
      }

      if (!agentId) {
        console.error('Chat widget: Missing data-agent-id attribute');
        return;
      }

      console.log('Chat widget: Initializing with agentId:', agentId, 'type:', type, 'baseUrl:', baseUrl);

      // No persistent customer data: new visitor/session on every page load so refresh starts fresh
      function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          const r = Math.random() * 16 | 0;
          const v = c === 'x' ? r : (r & 0x3 | 0x8);
          return v.toString(16);
        });
      }

      function getNewVisitorId() {
        return generateUUID();
      }

      function getNewSessionId() {
        return generateUUID();
      }

      const visitorId = getNewVisitorId();
      const embedBaseUrl = `${baseUrl}/embed/${agentId}`;

      function buildIframeUrl(sessionId) {
        const params = new URLSearchParams();
        if (visitorId) params.set('visitorId', visitorId);
        if (sessionId) params.set('sessionId', sessionId);
        const query = params.toString();
        return query ? `${embedBaseUrl}?${query}` : embedBaseUrl;
      }

      let inlineIframe = null;
      let isOpen = false;
      let toggleChatWindow = null;

      if (type === 'inline') {
        // Inline mode: insert into target element
        const targetElement = target ? document.getElementById(target) : null;
        if (!targetElement) {
          console.error('Chat widget: Target element not found for inline mode');
          return;
        }

        const iframe = document.createElement('iframe');
        const inlineSessionId = getNewSessionId();
        iframe.src = buildIframeUrl(inlineSessionId);
        iframe.frameBorder = '0';
        iframe.title = 'AI Agent Chat';
        iframe.setAttribute('allow', 'microphone');
        iframe.style.cssText = `
      display: block;
      width: 100%;
      height: 580px;
      border: none;
      border-radius: 16px;
      box-shadow: 0 4px 32px rgba(0,0,0,0.10), 0 0 20px rgba(20,184,166,0.15), 0 0 40px rgba(20,184,166,0.06);
      background: #fff;
      overflow: hidden;
      border: 1.5px solid rgba(20,184,166,0.18);
      transition: box-shadow 0.4s ease;
    `;
        iframe.addEventListener('mouseenter', () => {
          iframe.style.boxShadow = '0 4px 32px rgba(0,0,0,0.10), 0 0 28px rgba(20,184,166,0.22), 0 0 56px rgba(20,184,166,0.10)';
        });
        iframe.addEventListener('mouseleave', () => {
          iframe.style.boxShadow = '0 4px 32px rgba(0,0,0,0.10), 0 0 20px rgba(20,184,166,0.15), 0 0 40px rgba(20,184,166,0.06)';
        });

        // Wrap in a container div: 75% centered within the target element
        const container = document.createElement('div');
        container.className = 'wai-inline-container';
        container.style.cssText = `
      width: 75%;
      margin: 0 auto;
      display: block;
    `;
        // Inject inline-mode responsive styles
        if (!document.getElementById('wai-inline-responsive')) {
          const rs = document.createElement('style');
          rs.id = 'wai-inline-responsive';
          rs.textContent = `
            @media (max-width: 640px) {
              .wai-inline-container {
                width: 100% !important;
                height: 100dvh !important;
                position: fixed !important;
                top: 0 !important; left: 0 !important;
                margin: 0 !important;
                z-index: 9990;
              }
              .wai-inline-container iframe {
                height: 100% !important;
                border-radius: 0 !important;
                box-shadow: none !important;
                border: none !important;
              }
            }
          `;
          document.head.appendChild(rs);
        }
        container.appendChild(iframe);
        targetElement.appendChild(container);
        inlineIframe = iframe;
      } else {
        // Floating mode: create floating button and chat window
        let chatWindow = null;
        let chatButton = null;

        // Create floating button (icon from public folder)
        chatButton = document.createElement('button');
        chatButton.setAttribute('aria-label', 'Open chat');
        chatButton.setAttribute('type', 'button');
        var iconImg = document.createElement('img');
        iconImg.src = baseUrl + '/robot-assistant.png';
        iconImg.alt = '';
        iconImg.width = 32;
        iconImg.height = 32;
        iconImg.style.objectFit = 'contain';
        chatButton.appendChild(iconImg);
        // Inject glow keyframes + mobile responsive styles once
        if (!document.getElementById('wai-widget-glow-styles')) {
          const glowStyle = document.createElement('style');
          glowStyle.id = 'wai-widget-glow-styles';
          glowStyle.textContent = `
            @keyframes wai-btn-glow {
              0%, 100% { box-shadow: 0 4px 14px rgba(20,184,166,0.35), 0 0 20px rgba(20,184,166,0.2); }
              50% { box-shadow: 0 4px 20px rgba(20,184,166,0.5), 0 0 32px rgba(20,184,166,0.3); }
            }
            @media (max-width: 640px) {
              [id^="ai-agent-chat-window-"] {
                top: 0 !important;
                bottom: 0 !important;
                right: 0 !important;
                left: 0 !important;
                width: 100vw !important;
                height: 100dvh !important;
                max-width: 100vw !important;
                max-height: 100dvh !important;
                border-radius: 0 !important;
                border: none !important;
              }
              [id^="ai-agent-chat-window-"] iframe {
                border-radius: 0 !important;
              }
            }
          `;
          document.head.appendChild(glowStyle);
        }
        chatButton.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background:#14b8a6;
      color: white;
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(20,184,166,0.35), 0 0 20px rgba(20,184,166,0.2);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, box-shadow 0.3s;
      animation: wai-btn-glow 2.5s ease-in-out infinite;
    `;
        chatButton.addEventListener('mouseenter', () => {
          chatButton.style.transform = 'scale(1.1)';
        });
        chatButton.addEventListener('mouseleave', () => {
          chatButton.style.transform = 'scale(1)';
        });

        // Create chat window
        function createChatWindow(sessionId) {
          if (chatWindow) return; // Already created

          chatWindow = document.createElement('div');
          chatWindow.id = 'ai-agent-chat-window-' + agentId;
          chatWindow.style.cssText = `
        position: fixed;
        bottom: 90px;
        right: 20px;
        width: 400px;
        height: 600px;
        max-width: calc(100vw - 40px);
        max-height: calc(100vh - 120px);
        background: white;
        border-radius: 14px;
        border: 1.5px solid rgba(20,184,166,0.2);
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.15), 0 0 24px rgba(20,184,166,0.18), 0 0 48px rgba(20,184,166,0.07);
        z-index: 9998;
        display: none;
        flex-direction: column;
        overflow: hidden;
        opacity: 0;
        transform: translateY(20px);
        visibility: hidden;
        transition: opacity 0.3s ease, transform 0.3s ease, visibility 0.3s, box-shadow 0.4s ease;
      `;

          const iframe = document.createElement('iframe');
          iframe.src = buildIframeUrl(sessionId);
          iframe.style.cssText = `
        width: 100%;
        height: 100%;
        border: none;
        border-radius: 12px;
      `;
          iframe.title = 'AI Agent Chat';
          iframe.setAttribute('allow', 'microphone');
          iframe.setAttribute('allowfullscreen', 'true');

          chatWindow.appendChild(iframe);

          if (document.body) {
            document.body.appendChild(chatWindow);
            console.log('Chat widget: Chat window created');
          } else {
            console.error('Chat widget: document.body not available');
          }
        }

        // Toggle chat window function
        toggleChatWindow = function toggleChatWindow(e) {
          if (e) {
            e.preventDefault();
            e.stopPropagation();
          }

          if (!isOpen) {
            // Open chat
            const sessionId = getNewSessionId();
            if (!chatWindow) {
              createChatWindow(sessionId);
            }
            // Show chat window
            chatWindow.style.display = 'flex';
            // Force reflow to ensure display change is applied before transition
            void chatWindow.offsetHeight;
            // Trigger transition
            setTimeout(() => {
              chatWindow.style.opacity = '1';
              chatWindow.style.transform = 'translateY(0)';
              chatWindow.style.visibility = 'visible';
            }, 10);
            isOpen = true;
          } else {
            // Close chat
            chatWindow.style.opacity = '0';
            chatWindow.style.transform = 'translateY(20px)';
            setTimeout(() => {
              if (chatWindow) {
                chatWindow.style.display = 'none';
                chatWindow.style.visibility = 'hidden';
              }
            }, 300);
            isOpen = false;
          }
        }

        // Add click handler to button
        chatButton.addEventListener('click', toggleChatWindow);

        // Check if button already exists
        const existingButton = document.getElementById('ai-agent-chat-button-' + agentId);
        if (existingButton) {
          console.log('Chat widget: Button already exists, skipping...');
          return;
        }

        chatButton.id = 'ai-agent-chat-button-' + agentId;

        // Append button to body
        function appendButton() {
          if (document.body) {
            document.body.appendChild(chatButton);
            console.log('Chat widget: Button appended to body');
          } else {
            // Wait for body to be available
            const observer = new MutationObserver(() => {
              if (document.body) {
                document.body.appendChild(chatButton);
                console.log('Chat widget: Button appended to body (delayed)');
                observer.disconnect();
              }
            });
            observer.observe(document.documentElement, { childList: true });
            // Timeout fallback
            setTimeout(() => {
              if (document.body && !document.getElementById(chatButton.id)) {
                document.body.appendChild(chatButton);
                observer.disconnect();
              }
            }, 1000);
          }
        }

        appendButton();

        // Close on outside click
        document.addEventListener('click', (e) => {
          if (isOpen && chatWindow && !chatWindow.contains(e.target) && !chatButton.contains(e.target)) {
            toggleChatWindow(e);
          }
        });
      }
    }

    // Listen for close/minimize message from embedded chat
    window.addEventListener('message', (event) => {
      const data = event && event.data ? event.data : null;
      if (!data || data.type !== 'ai-embed-chat-close') return;
      if (type === 'inline') {
        if (inlineIframe) {
          inlineIframe.style.display = 'none';
        }
        return;
      }
      if (typeof toggleChatWindow === 'function' && isOpen) {
        toggleChatWindow();
      }
    });

    // Initialize when DOM is ready
    function startInit() {
      try {
        initWidget();
      } catch (error) {
        console.error('Chat widget: Error during initialization:', error);
      }
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startInit);
    } else {
      // DOM already ready, but wait a bit to ensure everything is loaded
      if (window.addEventListener) {
        window.addEventListener('load', startInit);
      }
      // Also try immediately
      setTimeout(startInit, 100);
    }
  }
})();
