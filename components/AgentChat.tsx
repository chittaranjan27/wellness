/**
 * Agent Chat Component
 * Chat interface with text and voice input/output
 */
"use client";

import { useState, useRef, useEffect } from "react";
import { jsPDF } from "jspdf";
import { ChatMessage as ChatMessageType } from "@prisma/client";
import ChatMessage from "./ChatMessage";
import VoiceChatButton from "./VoiceChatButton";
import SalesAgentPanel from "./SalesAgentPanel";
import { getLanguageByCode, getDefaultLanguage, SUPPORTED_LANGUAGES } from "@/lib/languages";

type ProfileStage = "name" | "email" | "otp" | null;

interface VisitorProfile {
  name?: string | null;
  age?: number | null;
  origin?: string | null;
  phone?: string | null;
  phoneSkipped?: boolean;
  email?: string | null;
  emailVerifiedAt?: string | null;
}

interface ProductItem {
  id: string;
  title: string;
  description?: string | null;
  price?: string | null;
  url: string;
  imageUrl?: string | null;
  features?: string[];
  variantId?: string | null; // Shopify numeric variant ID for cart/add URL
}

interface CartItem {
  product: ProductItem;
  quantity: number;
}

interface AgentChatProps {
  agentId: string;
  initialMessages: ChatMessageType[];
  defaultLanguage?: string;
  apiEndpoint?: string; // Optional: custom API endpoint (defaults to '/api/chat')
  visitorId?: string; // Optional: visitor ID for embedded chats
  sessionId?: string; // Optional: session ID for embedded chats
}

export default function AgentChat({
  agentId,
  initialMessages,
  defaultLanguage = "en",
  apiEndpoint = "/api/chat",
  visitorId,
  sessionId,
}: AgentChatProps) {
  const [messages, setMessages] = useState(initialMessages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [showVoicePopup, setShowVoicePopup] = useState(false);
  const [selectedLanguage, setSelectedLanguage] = useState(defaultLanguage);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [profileStage, setProfileStage] = useState<ProfileStage>(null);
  const [profileData, setProfileData] = useState<VisitorProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [languageConfirmed, setLanguageConfirmed] = useState(false);
  const [lastPromptStage, setLastPromptStage] = useState<ProfileStage>(null);
  const [welcomeShown, setWelcomeShown] = useState(false);
  const [reportData, setReportData] = useState<any | null>(null);
  const reportNoticeShownRef = useRef(false);
  const [productResults, setProductResults] = useState<ProductItem[]>([]);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [checkoutLink, setCheckoutLink] = useState<string | null>(null);
  const [addingProductIds, setAddingProductIds] = useState<Set<string>>(new Set());
  const cartPromptedRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<any>(null); // SpeechRecognition type defined in types/speech.d.ts
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const isInitializedRef = useRef(false);
  const isEmbedChat = Boolean(visitorId && apiEndpoint === "/api/embed/chat");
  const otpReminderRef = useRef<NodeJS.Timeout | null>(null);
  const otpPromptedRef = useRef(false);
  const [otpPromptedAt, setOtpPromptedAt] = useState<number | null>(null);
  const [inputPlaceholder, setInputPlaceholder] = useState<string>(() =>
    isEmbedChat ? "Select a language to begin..." : "Ask me anything..."
  );
  const [currentCategory, setCurrentCategory] = useState<string | null>(null);
  const otherModeRef = useRef(false);
  // Track which variant is selected for each product group (baseKey -> selected product id)
  const [selectedVariants, setSelectedVariants] = useState<Record<string, string>>({});
  // Mobile tab toggle: 'chat' or 'picks' — only affects mobile layout
  const [mobileTab, setMobileTab] = useState<'chat' | 'picks'>('chat');
  // Landing hub mode: null = show hub, 'consultation' = chat mode, 'offers' = show products, 'voice' = voice interaction, 'sales' = sales agent
  const [chatMode, setChatMode] = useState<'consultation' | 'offers' | 'voice' | 'sales' | null>(null);
  const [salesConcern, setSalesConcern] = useState('');
  const chatModeRef = useRef(chatMode);
  const handleSendMessageRef = useRef<(msg: string) => void>(() => { });
  // Voice consultation mode: auto-speak AI replies, auto-restart mic after TTS ends
  const voiceModeRef = useRef(false);
  const voiceAutoListenRef = useRef(false);
  const [voiceCallActive, setVoiceCallActive] = useState(false);
  // DB products for Offers & Products full-screen view
  const [dbProducts, setDbProducts] = useState<Array<{
    id: string; title: string; price: string; priceMin: string; priceMax: string;
    supplyDays: number; capsuleCount: number; dailyDose: number;
    market: string; funnelRole: string; discountEligible: boolean; discountPct: string | null;
    imageUrl: string | null; url: string | null;
  }>>([]);
  const [dbProductsLoading, setDbProductsLoading] = useState(false);

  /**
   * Detect the user's primary concern from conversation history by keyword matching.
   */
  const detectSalesConcern = (history: Array<{ role: string; content: string }>): string => {
    const allText = history.map(m => m.content).join(' ').toLowerCase();
    const categories: Array<{ name: string; keywords: string[] }> = [
      { name: 'Low energy & fatigue', keywords: ['energy', 'tired', 'fatigue', 'exhausted', 'weak', 'drained', 'lethargic', 'ऊर्जा', 'थकान'] },
      { name: 'Stamina & performance', keywords: ['stamina', 'endurance', 'performance', 'fitness', 'workout', 'strength', 'स्टैमिना'] },
      { name: 'Confidence & intimate wellness', keywords: ['confidence', 'intimate', 'bedroom', 'libido', 'desire', 'sexual', 'आत्मविश्वास'] },
      { name: 'Diabetes & blood sugar', keywords: ['diabetes', 'blood sugar', 'sugar level', 'diabetic', 'glucose', 'insulin', 'मधुमेह', 'शुगर'] },
      { name: 'General strength & recovery', keywords: ['recovery', 'general', 'overall', 'health', 'immunity', 'wellness', 'healing', 'रिकवरी'] },
    ];
    let bestMatch = '';
    let bestScore = 0;
    for (const cat of categories) {
      let score = 0;
      for (const kw of cat.keywords) {
        if (allText.includes(kw)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = cat.name;
      }
    }
    return bestMatch || currentCategory || 'General wellness';
  };

  /**
   * Group products by base name so duration/combo variants appear together.
   * E.g. "Vitality Boost 15-day" and "Vitality Boost 30-day" share baseKey "vitality boost".
   * Returns an array of groups, each with a baseKey and variant products.
   */
  const VARIANT_RE = /\b(\d+)\s*[-–]?\s*(day|days|month|months|week|weeks|capsule|capsules|tablet|tablets|sachet|sachets|ml|gm|gram|grams|kg|pack|packs|bottle|bottles|strips?)\b/gi;
  const COMBO_RE = /\bcombo\b|\bbundle\b|\bkit\b|\bpack\b|\bset\b|\bcollection\b|\bduo\b|\btrio\b/i;

  function getProductBaseKey(title: string): string {
    return (title || '')
      .toLowerCase()
      .replace(VARIANT_RE, '')
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function getVariantLabel(title: string): string | null {
    const matches = [...(title || '').matchAll(VARIANT_RE)];
    if (matches.length === 0) return null;
    return matches.map(m => `${m[1]} ${m[2]}`).join(', ');
  }

  interface ProductGroup {
    baseKey: string;
    products: ProductItem[];
  }

  function groupProductsByBase(products: ProductItem[]): ProductGroup[] {
    const groups = new Map<string, ProductItem[]>();
    const order: string[] = [];
    for (const product of products) {
      const isCombo = COMBO_RE.test(product.title || '');
      // Combo/bundle products stand alone — never group with individual products
      const key = isCombo ? `__combo__${product.id}` : getProductBaseKey(product.title || '');
      if (!key || key.length < 3) {
        const soloKey = `__solo__${product.id}`;
        groups.set(soloKey, [product]);
        order.push(soloKey);
        continue;
      }
      if (!groups.has(key)) {
        groups.set(key, []);
        order.push(key);
      }
      groups.get(key)!.push(product);
    }
    return order.map(key => ({ baseKey: key, products: groups.get(key)! }));
  }

  function handleVariantSelect(baseKey: string, productId: string) {
    setSelectedVariants(prev => ({ ...prev, [baseKey]: productId }));
  }

  const scrollToBottom = () => {
    if (messagesEndRef.current) {
      // Find the specific container that is scrollable within the chat widget
      const scrollableParent = messagesEndRef.current.closest('.wai-messages, .wai-voice-transcript, .overflow-y-auto');
      if (scrollableParent) {
        // Set the scroll top of the exact container, preventing the whole website from jumping
        scrollableParent.scrollTo({
          top: scrollableParent.scrollHeight,
          behavior: 'smooth'
        });
      } else {
        // Fallback for dashboard/standalone view with improved block behavior
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  };

  const handleCategoryClick = (category: string) => {
    setCurrentCategory(category);
    if (!languageConfirmed) {
      addAssistantMessage("Please select a language to continue.");
      return;
    }
    handleSendMessage(`I need help with ${category.toLowerCase()}`);
  };

  // Keep chatModeRef + voiceModeRef in sync with chatMode state
  useEffect(() => {
    chatModeRef.current = chatMode;
    voiceModeRef.current = chatMode === 'voice';
    if (chatMode !== 'voice') {
      voiceAutoListenRef.current = false;
      setVoiceCallActive(false);
    }
  }, [chatMode]);

  // Keep checkout link in sync with cart (no separate "Generate" step)
  useEffect(() => {
    if (cartItems.length === 0) {
      cartPromptedRef.current = false;
      setCheckoutLink(null);
    } else {
      setCheckoutLink(buildCheckoutLink(cartItems));
    }
  }, [cartItems]);

  // Sync input placeholder when language/embed state changes (unless user chose "Other")
  useEffect(() => {
    if (!otherModeRef.current) {
      setInputPlaceholder(
        isEmbedChat && !languageConfirmed ? "Select a language to begin..." : "Ask me anything..."
      );
    }
  }, [isEmbedChat, languageConfirmed]);

  // Fetch Shopify products when Offers & Products view is opened
  useEffect(() => {
    if (chatMode !== 'offers') return;
    if (dbProducts.length > 0) return; // already loaded
    setDbProductsLoading(true);
    fetch('/api/shopify/products')
      .then(res => res.json())
      .then(data => {
        const products = Array.isArray(data.products) ? data.products : [];
        // Map Shopify products to include description, tags, variants, url, variantId
        const mapped = products.map((p: any) => {
          const variants = Array.isArray(p.variants) ? p.variants : [];
          // Use first available variant ID for Add to Cart
          const firstVariant = variants.find((v: any) => v.available !== false) || variants[0];
          return {
            id: p.id,
            title: p.title,
            description: p.description || null,
            price: p.price || null,
            imageUrl: p.imageUrl || null,
            url: p.url || null,
            tags: Array.isArray(p.tags) ? p.tags : [],
            variants,
            variantId: firstVariant?.id || null, // Shopify variant ID for cart/add URL
          };
        });
        setDbProducts(mapped);
      })
      .catch(err => {
        console.error('[Offers] Failed to fetch Shopify products:', err);
        setDbProducts([]);
      })
      .finally(() => setDbProductsLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMode]);


  const addAssistantMessage = (content: string, suggestions?: Array<{ label: string; prompt: string }>) => {
    const assistantMessage: ChatMessageType = {
      id: `assistant-local-${Date.now()}`,
      agentId,
      sessionId: sessionId || null,
      visitorId: visitorId || null,
      role: "assistant",
      content,
      createdAt: new Date(),
      metadata: {
        source: "system",
        ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
      } as any,
    };
    setMessages((prev) => [...prev, assistantMessage]);
  };

  /**
   * Generate context-aware fallback suggestions when the LLM doesn't provide [OPTIONS].
   * Analyzes the AI response text + conversation state to produce relevant clickable options.
   * Returns 2–4 options written from the user's first-person perspective.
   */
  const generateFallbackSuggestions = (aiResponse: string, userMessage: string): Array<{ label: string; prompt: string }> => {
    const lang = selectedLanguage;
    const lowerResponse = aiResponse.toLowerCase();
    const lowerUser = userMessage.toLowerCase();

    // ── Phase detection based on AI response content ──────────────────

    // Age question detected
    if (/age|age group|how old|what.*age|उम्र|आयु/i.test(aiResponse)) {
      return lang === 'hi' ? [
        { label: '24-35 साल', prompt: 'मेरी उम्र 24-35 साल है' },
        { label: '35-45 साल', prompt: 'मेरी उम्र 35-45 साल है' },
        { label: '45-55 साल', prompt: 'मेरी उम्र 45-55 साल है' },
        { label: '55+ साल', prompt: 'मेरी उम्र 55 से अधिक है' },
      ] : [
        { label: '24-35 years', prompt: 'I am between 24-35 years old' },
        { label: '35-45 years', prompt: 'I am between 35-45 years old' },
        { label: '45-55 years', prompt: 'I am between 45-55 years old' },
        { label: '55+ years', prompt: 'I am above 55 years old' },
      ];
    }

    // First-time vs returning user question
    if (/first time|tried.*before|explored.*supplement|पहली बार|पहले कभी/i.test(aiResponse)) {
      return lang === 'hi' ? [
        { label: 'हाँ, पहली बार है', prompt: 'हाँ, यह मेरी पहली बार है' },
        { label: 'पहले try किया है', prompt: 'हाँ, मैंने पहले supplements try किए हैं' },
        { label: 'बस जानकारी चाहिए', prompt: 'मैं बस कुछ जानकारी चाहता हूँ' },
      ] : [
        { label: 'Yes, first time', prompt: 'Yes, this is my first time exploring supplements' },
        { label: "I've tried before", prompt: "I've tried supplements before but looking for something better" },
        { label: 'Just exploring', prompt: 'I am just exploring my options for now' },
      ];
    }

    // Concern / main issue question
    if (/what.*concern|what.*issue|what.*bring|what.*help|how can.*help|tell me more|main concern|किस.*समस्या|क्या.*परेशानी|कैसे.*मदद/i.test(aiResponse)) {
      return lang === 'hi' ? [
        { label: 'कम ऊर्जा और थकान', prompt: 'मुझे कम ऊर्जा और थकान हो रही है' },
        { label: 'स्टैमिना सुधारना है', prompt: 'मैं अपना स्टैमिना सुधारना चाहता हूँ' },
        { label: 'तनाव और नींद', prompt: 'मुझे तनाव और नींद की समस्या है' },
        { label: 'कुछ और है', prompt: 'मेरी कोई और समस्या है' },
      ] : [
        { label: 'Low energy & fatigue', prompt: "I'm experiencing low energy and constant fatigue" },
        { label: 'Stamina issues', prompt: 'I want to improve my stamina and endurance' },
        { label: 'Stress & sleep', prompt: "I'm dealing with stress and poor sleep" },
        { label: 'Something else', prompt: 'I have a different concern' },
      ];
    }

    // Product recommendation / price mention
    if (/₹|price|recommend|suggest.*product|trial.*pack|pack|capsule|सिफारिश|उत्पाद|कीमत/i.test(aiResponse)) {
      return lang === 'hi' ? [
        { label: 'हाँ, try करना है', prompt: 'हाँ, मैं इसे try करना चाहता हूँ' },
        { label: 'और जानकारी चाहिए', prompt: 'मुझे इसके बारे में और जानकारी चाहिए' },
        { label: 'कीमत ज्यादा लगती है', prompt: 'कीमत थोड़ी ज्यादा लगती है, कोई और option है?' },
        { label: 'कैसे लेना है?', prompt: 'इसे कैसे और कब लेना है?' },
      ] : [
        { label: "Yes, I'd like to try", prompt: "Yes, I'd like to try this product" },
        { label: 'Tell me more', prompt: 'Can you tell me more about how it works?' },
        { label: 'Seems expensive', prompt: 'The price seems a bit high. Any trial packs?' },
        { label: 'How to use it?', prompt: 'How should I take this? What is the dosage?' },
      ];
    }

    // Testimonial / trust building
    if (/customer|result|worked|testimonial|certified|herbal|natural|ग्राहक|प्रमाणित|हर्बल|प्राकृतिक/i.test(aiResponse)) {
      return lang === 'hi' ? [
        { label: 'यह जानकर अच्छा लगा', prompt: 'यह जानकर अच्छा लगा, आगे बताइए' },
        { label: 'कोई side effects?', prompt: 'क्या इसके कोई side effects हैं?' },
        { label: 'कितने दिन में असर?', prompt: 'कितने दिनों में असर दिखता है?' },
      ] : [
        { label: "That's reassuring", prompt: "That's good to know, please continue" },
        { label: 'Any side effects?', prompt: 'Are there any side effects I should know about?' },
        { label: 'How soon results?', prompt: 'How soon can I expect to see results?' },
      ];
    }

    // Dosage / lifestyle guidance
    if (/dosage|take.*with|avoid|lifestyle|sleep|exercise|doÌ£sage|खुराक|सेवन|नींद/i.test(aiResponse)) {
      return lang === 'hi' ? [
        { label: 'समझ गया', prompt: 'समझ गया, मैं इसे follow करूंगा' },
        { label: 'order कैसे करूं?', prompt: 'मैं इसे order कैसे करूं?' },
        { label: 'और सवाल है', prompt: 'मेरे कुछ और सवाल हैं' },
      ] : [
        { label: 'Got it, thanks', prompt: 'Got it, I will follow these guidelines' },
        { label: 'How to order?', prompt: 'How can I place an order?' },
        { label: 'I have more questions', prompt: 'I have a few more questions before deciding' },
      ];
    }

    // Closing / order question
    if (/order|start|ready|would you like|shall I|proceed|ऑर्डर|शुरू|तैयार/i.test(aiResponse)) {
      return lang === 'hi' ? [
        { label: 'हाँ, order करता हूँ', prompt: 'हाँ, मैं order करना चाहता हूँ' },
        { label: 'सोचने दीजिए', prompt: 'मुझे थोड़ा सोचने दीजिए' },
        { label: 'trial pack से शुरू', prompt: 'क्या मैं trial pack से शुरू कर सकता हूँ?' },
      ] : [
        { label: "Yes, let's order", prompt: "Yes, I'd like to place an order" },
        { label: 'Let me think', prompt: 'Let me think about it for a bit' },
        { label: 'Start with trial', prompt: 'Can I start with a trial pack first?' },
      ];
    }

    // Generic fallback — always provide something clickable
    return lang === 'hi' ? [
      { label: 'हाँ, बिल्कुल', prompt: 'हाँ, कृपया आगे बताइए' },
      { label: 'और बताइए', prompt: 'मुझे और जानकारी चाहिए' },
      { label: 'कोई और सवाल है', prompt: 'मेरा एक और सवाल है' },
    ] : [
      { label: 'Yes, please continue', prompt: 'Yes, please tell me more' },
      { label: 'I need more info', prompt: 'I would like more information about this' },
      { label: 'I have a question', prompt: 'I have another question' },
    ];
  };

  const buildCheckoutLink = (_items: CartItem[]) => {
    return 'https://stayonwellness.com/cart';
  };

  /**
   * Add to Cart via Shopify's cart/add URL.
   * Opens: https://stayonwellness.com/cart/add?id=<variant_id>&quantity=1&return_to=/cart
   * Each product must have a variantId (Shopify numeric variant ID).
   */
  const handleAddToCart = (product: ProductItem, quantity: number = 1) => {
    if (quantity < 1) return;

    // Extract numeric variant ID from Shopify GID (e.g. gid://shopify/ProductVariant/12345 → 12345)
    const rawVariantId = product.variantId || '';
    const numericId = rawVariantId.includes('/')
      ? rawVariantId.split('/').pop() || rawVariantId
      : rawVariantId;

    if (!numericId) {
      console.error('[Cart] No variant ID for product:', product.title);
      return;
    }

    const addToCartUrl = `https://stayonwellness.com/cart/add?id=${numericId}&quantity=${quantity}&return_to=/cart`;
    console.log(`[Cart] Opening: ${addToCartUrl}`);

    // Open in new tab — Shopify adds to cart and redirects to /cart
    window.open(addToCartUrl, '_blank');

    // Mark as added in local state
    setCartItems((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);
      if (existing) {
        return prev.map((item) =>
          item.product.id === product.id ? { ...item, quantity } : item
        );
      }
      return [...prev, { product, quantity }];
    });
  };

  const handleUpdateCartQuantity = (productId: string, delta: number) => {
    setCartItems((prev) => {
      const next = prev.map((item) => {
        if (item.product.id !== productId) return item;
        const newQty = Math.max(0, item.quantity + delta);
        return { ...item, quantity: newQty };
      }).filter((item) => item.quantity > 0);
      return next;
    });
    setCheckoutLink(null);
  };

  // At start we only ask for name; consultation begins right after. Email/OTP are only
  // requested after the report is ready (optional, to send the report).
  const getNextProfileStage = (profile: VisitorProfile | null): ProfileStage => {
    if (!profile?.name) return "name";
    return null;
  };

  // Used when we need the next stage for post-report optional email (not at start).
  const getNextProfileStageFull = (profile: VisitorProfile | null): ProfileStage => {
    if (!profile?.name) return "name";
    if (!profile?.email) return "email";
    if (!profile?.emailVerifiedAt) return "otp";
    return null;
  };

  // Multilingual system message lookup
  const t = (key: string): string => {
    const map: Record<string, Record<string, string>> = {
      namePrompt: { en: "What should I call you?", hi: "आपका नाम क्या है?" },
      emailPrompt: { en: "Please enter your email address to continue.", hi: "कृपया अपना ईमेल पता दर्ज करें।" },
      otpSent: { en: "I sent a 6-digit code to your email. Please enter the OTP to verify.", hi: "मैंने आपके ईमेल पर एक 6-अंकीय कोड भेजा है। कृपया OTP दर्ज करें।" },
      otpReminder: { en: "Reminder: please enter the 6-digit OTP sent to your email.", hi: "याद दिलाएं: OTP दर्ज करें।" },
      otpVerified: { en: "Thanks! I've sent the report to your email. You can also download it above anytime.", hi: "धन्यवाद! रिपोर्ट ईमेल पर भेज दी है।" },
      otpVerifiedNoRep: { en: "Thanks! Your email is verified. How can I help you today?", hi: "धन्यवाद! ईमेल सत्यापित हो गया। आज मैं आपकी कैसे मदद करूँ?" },
      otpInvalid: { en: "Invalid or expired code. Please try again.", hi: "अमान्य कोड। पुनः प्रयास करें।" },
      otpSentVerify: { en: "I've sent a 6-digit code to your email. Please enter it to verify and I'll send the report to your inbox.", hi: "ईमेल पर 6-अंकीय कोड भेजा है। दर्ज करें और रिपोर्ट भेज दूंगा।" },
      otpFailed: { en: "I couldn't send the code. Please check the address and try again.", hi: "कोड नहीं भेजा जा सका। पता जांचें और पुनः प्रयास करें।" },
      skipCart: { en: "No problem. You can download the report anytime above.", hi: "कोई बात नहीं। आप रिपोर्ट कभी भी ऊपर से डाउनलोड कर सकते हैं।" },
      validResponse: { en: "Please enter a valid response.", hi: "वैध उत्तर दर्ज करें।" },
      validEmail: { en: "Please enter a valid email address.", hi: "वैध ईमेल पता दर्ज करें।" },
      genericError: { en: "Something went wrong. Please try again.", hi: "कुछ गड़बड़ हुई। पुनः प्रयास करें।" },
      selectLanguage: { en: "Please select a language to continue.", hi: "कृपया एक भाषा चुनें।" },
      welcomeBack: { en: "Welcome back, {name}!", hi: "वापसी पर स्वागत है, {name}!" },
    };
    const lang = selectedLanguage in (map[key] || {}) ? selectedLanguage : 'en';
    return (map[key] || {})[lang] || (map[key] || {})['en'] || key;
  };

  const tName = (name: string) => t('welcomeBack').replace('{name}', name);

  // Warm greeting in the user's selected language — shown after language selection
  const getGreetingForNamePrompt = (languageCode: string): { text: string; suggestions: Array<{ label: string; prompt: string }> } => {
    const greetings: Record<string, string> = {
      en: "Hello! Welcome to Wellness AI. I'm your personal wellness consultant — here to support your physical, mental, and lifestyle well-being.",
      hi: "नमस्ते! Wellness AI में आपका स्वागत है। मैं आपका व्यक्तिगत वेलनेस सलाहकार हूँ — शारीरिक, मानसिक और जीवनशैली से जुड़ी समस्याओं में आपकी मदद के लिए यहाँ हूँ।",
    };
    // No chips on greeting since the next message is the name prompt
    return {
      text: greetings[languageCode] ?? greetings.en,
      suggestions: [],
    };
  };

  const promptForStage = (stage: ProfileStage) => {
    if (!stage) return;
    // Only name is prompted at conversation start; email/otp are used after report.  
    const stageMap: Record<string, string> = {
      name: t('namePrompt'),
      email: t('emailPrompt'),
    };
    const prompt = stageMap[stage];
    if (prompt) {
      // Add name input suggestions (common name examples for quicker tap)
      const nameSuggestions = stage === 'name' ? [] : undefined; // Name is free-form, no chips
      const emailSuggestions = stage === 'email' ? (
        selectedLanguage === 'hi' ? [
          { label: 'बाद में बताऊंगा', prompt: 'मैं बाद में email दूंगा' },
        ] : [
          { label: "I'll share later", prompt: "I'll share my email later" },
        ]
      ) : undefined;
      addAssistantMessage(prompt, emailSuggestions);
    }
  };

  const callProfileAction = async (action: string, payload: Record<string, any> = {}) => {
    const requestBody: any = {
      agentId,
      visitorId,
      sessionId,
      action,
      ...payload,
    };

    const response = await fetch(apiEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Request failed");
    }

    return data;
  };

  const updateProfile = async (updates: Record<string, any>) => {
    const data = await callProfileAction("update_profile", { profile: updates });
    const profile = data?.profile || null;
    setProfileData(profile);
    setProfileStage(getNextProfileStage(profile));
    return profile;
  };

  const handleProfileInput = async (stage: ProfileStage, value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      addAssistantMessage("Please enter a valid response.");
      return;
    }

    if (stage === "name") {
      await updateProfile({ name: trimmed });
      const firstName = trimmed.split(" ")[0];

      // Intro text — short greeting, privacy note, prompt
      const introText: Record<string, string> = {
        en: `Nice to meet you, ${firstName}! 😊\n\nYour conversation is completely private and confidential.\n\nWhat brings you here today? Please select your main concern:`,
        hi: `आपसे मिलकर अच्छा लगा, ${firstName}! 😊\n\nआपकी बातचीत पूरी तरह निजी और गोपनीय है।\n\nआज आप किस विषय में मदद चाहते हैं?`,
      };

      // Concern chips — label shown on button, prompt sent to AI when clicked
      const concernChips: Record<string, Array<{ label: string; prompt: string }>> = {
        en: [
          { label: "Low energy & fatigue", prompt: "I'm experiencing low energy and fatigue. What can I do?" },
          { label: "Stamina & performance", prompt: "I want to improve my stamina and performance." },
          { label: "Confidence & intimate wellness", prompt: "I'm facing concerns around confidence and intimate wellness." },
          { label: "Diabetes / Blood sugar", prompt: "I need help managing my diabetes or blood sugar levels." },
          { label: "General strength & recovery", prompt: "I want to improve my general strength and recovery." },
        ],
        hi: [
          { label: "कम ऊर्जा और थकान", prompt: "मुझे कम ऊर्जा और थकान हो रही है। मैं क्या करूँ?" },
          { label: "स्टैमिना और परफॉर्मेंस", prompt: "मैं अपना स्टैमिना और परफॉर्मेंस सुधारना चाहता हूँ।" },
          { label: "आत्मविश्वास और अंतरंग स्वास्थ्य", prompt: "मुझे आत्मविश्वास और अंतरंग स्वास्थ्य से जुड़ी समस्याएँ हैं।" },
          { label: "मधुमेह / ब्लड शुगर", prompt: "मुझे मधुमेह या ब्लड शुगर प्रबंधन में मदद चाहिए।" },
          { label: "सामान्य शक्ति और रिकवरी", prompt: "मैं अपनी सामान्य शक्ति और रिकवरी सुधारना चाहता हूँ।" },
        ],
      };

      const lang = selectedLanguage in introText ? selectedLanguage : "en";

      // Add as assistant message with metadata.suggestions so chips render automatically
      const openerMessage: ChatMessageType = {
        id: `assistant-local-${Date.now()}`,
        agentId,
        sessionId: sessionId || null,
        visitorId: visitorId || null,
        role: "assistant",
        content: introText[lang],
        createdAt: new Date(),
        metadata: {
          source: "system",
          suggestions: concernChips[lang] ?? concernChips.en,
        } as any,
      };
      setMessages((prev) => [...prev, openerMessage]);
      setWelcomeShown(true);
      return;
    }


    if (stage === "email") {
      const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
      if (!emailRegex.test(trimmed)) {
        addAssistantMessage("Please enter a valid email address.");
        return;
      }
      await updateProfile({ email: trimmed });
      try {
        await callProfileAction("request_otp", { email: trimmed });
        setProfileStage("otp");
        setLastPromptStage(null);
        setOtpPromptedAt(null);
      } catch (error) {
        console.error("OTP request error:", error);
        addAssistantMessage("I couldn't send the OTP. Please try again.");
      }
      return;
    }

    if (stage === "otp") {
      const code = trimmed.replace(/\s+/g, "");
      try {
        const data = await callProfileAction("verify_otp", { code });
        const profile = data?.profile || null;
        setProfileData(profile);
        setProfileStage(getNextProfileStageFull(profile));
        if (data?.verified) {
          if (reportData) {
            addAssistantMessage("Thanks! I've sent the report to your email. You can also download it above anytime.");
          } else {
            addAssistantMessage("Thanks! Your email is verified. How can I help you today?");
          }
        } else {
          addAssistantMessage("Invalid or expired code. Please try again.");
        }
      } catch (error) {
        addAssistantMessage("Invalid or expired code. Please try again.");
      }
      return;
    }
  };

  const mergeReportWithProfile = (report: any) => {
    if (!report || typeof report !== "object") return report;
    const clientInfo = report.clientInfo && typeof report.clientInfo === "object" ? report.clientInfo : {};
    const merged = {
      ...report,
      clientInfo: {
        name: profileData?.name ?? clientInfo.name ?? null,
        age: profileData?.age ?? clientInfo.age ?? null,
        origin: profileData?.origin ?? clientInfo.origin ?? null,
        phone: profileData?.phone ?? clientInfo.phone ?? null,
        email: profileData?.email ?? clientInfo.email ?? null,
      },
    };
    return merged;
  };

  const formatReportText = (report: any) => {
    const normalizedReport = mergeReportWithProfile(report);
    const lines: string[] = [];

    // Header
    lines.push("CONSULTATION REPORT");
    lines.push("=".repeat(80));
    lines.push("");

    // Consultation Date
    if (normalizedReport?.consultationDate) {
      const date = new Date(normalizedReport.consultationDate);
      lines.push(`Date: ${date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })}`);
      lines.push("");
    }

    // Client Information
    lines.push("CLIENT INFORMATION");
    lines.push("-".repeat(80));
    if (normalizedReport?.clientInfo) {
      const ci = normalizedReport.clientInfo;
      if (ci.name) lines.push(`Name: ${ci.name}`);
      if (ci.age) lines.push(`Age: ${ci.age}`);
      if (ci.origin) lines.push(`Location: ${ci.origin}`);
      if (ci.email) lines.push(`Email: ${ci.email}`);
      if (ci.phone) lines.push(`Phone: ${ci.phone}`);
    }
    lines.push("");

    // Executive Summary
    if (normalizedReport?.executiveSummary) {
      lines.push("EXECUTIVE SUMMARY");
      lines.push("-".repeat(80));
      lines.push(normalizedReport.executiveSummary);
      lines.push("");
    } else if (normalizedReport?.summary) {
      lines.push("SUMMARY");
      lines.push("-".repeat(80));
      lines.push(normalizedReport.summary);
      lines.push("");
    }

    // Presenting Concerns
    if (normalizedReport?.presentingConcerns && Array.isArray(normalizedReport.presentingConcerns) && normalizedReport.presentingConcerns.length > 0) {
      lines.push("PRESENTING CONCERNS");
      lines.push("-".repeat(80));
      normalizedReport.presentingConcerns.forEach((concern: string, idx: number) => {
        lines.push(`${idx + 1}. ${concern}`);
      });
      lines.push("");
    }

    // Client History
    if (normalizedReport?.clientHistory) {
      lines.push("CLIENT HISTORY");
      lines.push("-".repeat(80));
      lines.push(normalizedReport.clientHistory);
      lines.push("");
    }

    // Assessment
    if (normalizedReport?.assessment) {
      lines.push("ASSESSMENT");
      lines.push("-".repeat(80));

      if (normalizedReport.assessment.problems && Array.isArray(normalizedReport.assessment.problems) && normalizedReport.assessment.problems.length > 0) {
        lines.push("Identified Problems:");
        normalizedReport.assessment.problems.forEach((problem: string, idx: number) => {
          lines.push(`  ${idx + 1}. ${problem}`);
        });
        lines.push("");
      }

      if (normalizedReport.assessment.goals && Array.isArray(normalizedReport.assessment.goals) && normalizedReport.assessment.goals.length > 0) {
        lines.push("Client Goals:");
        normalizedReport.assessment.goals.forEach((goal: string, idx: number) => {
          lines.push(`  ${idx + 1}. ${goal}`);
        });
        lines.push("");
      }

      if (normalizedReport.assessment.constraints && Array.isArray(normalizedReport.assessment.constraints) && normalizedReport.assessment.constraints.length > 0) {
        lines.push("Constraints:");
        normalizedReport.assessment.constraints.forEach((constraint: string, idx: number) => {
          lines.push(`  ${idx + 1}. ${constraint}`);
        });
        lines.push("");
      }
    } else {
      // Fallback to old structure
      if (normalizedReport?.problems && Array.isArray(normalizedReport.problems) && normalizedReport.problems.length > 0) {
        lines.push("ASSESSMENT - IDENTIFIED PROBLEMS");
        lines.push("-".repeat(80));
        normalizedReport.problems.forEach((problem: string, idx: number) => {
          lines.push(`${idx + 1}. ${problem}`);
        });
        lines.push("");
      }

      if (normalizedReport?.goals && Array.isArray(normalizedReport.goals) && normalizedReport.goals.length > 0) {
        lines.push("ASSESSMENT - CLIENT GOALS");
        lines.push("-".repeat(80));
        normalizedReport.goals.forEach((goal: string, idx: number) => {
          lines.push(`${idx + 1}. ${goal}`);
        });
        lines.push("");
      }

      if (normalizedReport?.constraints && Array.isArray(normalizedReport.constraints) && normalizedReport.constraints.length > 0) {
        lines.push("ASSESSMENT - CONSTRAINTS");
        lines.push("-".repeat(80));
        normalizedReport.constraints.forEach((constraint: string, idx: number) => {
          lines.push(`${idx + 1}. ${constraint}`);
        });
        lines.push("");
      }
    }

    // Previous Attempts
    if (normalizedReport?.previousAttempts && Array.isArray(normalizedReport.previousAttempts) && normalizedReport.previousAttempts.length > 0) {
      lines.push("PREVIOUS ATTEMPTS");
      lines.push("-".repeat(80));
      normalizedReport.previousAttempts.forEach((attempt: string, idx: number) => {
        lines.push(`${idx + 1}. ${attempt}`);
      });
      lines.push("");
    }

    // Recommendations
    if (normalizedReport?.recommendations && Array.isArray(normalizedReport.recommendations) && normalizedReport.recommendations.length > 0) {
      lines.push("RECOMMENDATIONS");
      lines.push("-".repeat(80));
      normalizedReport.recommendations.forEach((rec: string, idx: number) => {
        lines.push(`${idx + 1}. ${rec}`);
      });
      lines.push("");
    }

    // Action Plan
    if (normalizedReport?.actionPlan) {
      lines.push("ACTION PLAN");
      lines.push("-".repeat(80));

      if (normalizedReport.actionPlan.immediateSteps && Array.isArray(normalizedReport.actionPlan.immediateSteps) && normalizedReport.actionPlan.immediateSteps.length > 0) {
        lines.push("Immediate Steps:");
        normalizedReport.actionPlan.immediateSteps.forEach((step: string, idx: number) => {
          lines.push(`  ${idx + 1}. ${step}`);
        });
        lines.push("");
      }

      if (normalizedReport.actionPlan.shortTermGoals && Array.isArray(normalizedReport.actionPlan.shortTermGoals) && normalizedReport.actionPlan.shortTermGoals.length > 0) {
        lines.push("Short-term Goals (1-2 weeks):");
        normalizedReport.actionPlan.shortTermGoals.forEach((goal: string, idx: number) => {
          lines.push(`  ${idx + 1}. ${goal}`);
        });
        lines.push("");
      }

      if (normalizedReport.actionPlan.longTermGoals && Array.isArray(normalizedReport.actionPlan.longTermGoals) && normalizedReport.actionPlan.longTermGoals.length > 0) {
        lines.push("Long-term Goals (1-3 months):");
        normalizedReport.actionPlan.longTermGoals.forEach((goal: string, idx: number) => {
          lines.push(`  ${idx + 1}. ${goal}`);
        });
        lines.push("");
      }
    } else if (normalizedReport?.nextSteps && Array.isArray(normalizedReport.nextSteps) && normalizedReport.nextSteps.length > 0) {
      // Fallback to old structure
      lines.push("NEXT STEPS");
      lines.push("-".repeat(80));
      normalizedReport.nextSteps.forEach((step: string, idx: number) => {
        lines.push(`${idx + 1}. ${step}`);
      });
      lines.push("");
    }

    // Follow-up Questions
    if (normalizedReport?.followUpQuestions && Array.isArray(normalizedReport.followUpQuestions) && normalizedReport.followUpQuestions.length > 0) {
      lines.push("FOLLOW-UP QUESTIONS");
      lines.push("-".repeat(80));
      normalizedReport.followUpQuestions.forEach((question: string, idx: number) => {
        lines.push(`${idx + 1}. ${question}`);
      });
      lines.push("");
    }

    // Conversation Transcript - Complete record of ALL interactions
    // This section includes every question asked by the consultant and every response from the client
    // Brief responses have been rewritten into proper sentences for better readability
    if (normalizedReport?.conversationTranscript) {
      lines.push("CONVERSATION TRANSCRIPT");
      lines.push("-".repeat(80));
      lines.push("Complete record of all questions and responses during this consultation:");
      lines.push("");
      lines.push(normalizedReport.conversationTranscript);
      lines.push("");
    }

    // Footer
    lines.push("=".repeat(80));
    lines.push("End of Report");

    return lines.join("\n");
  };

  const downloadReport = () => {
    if (!reportData) return;
    const doc = new jsPDF();
    const normalizedReport = mergeReportWithProfile(reportData);
    const text = formatReportText(normalizedReport);

    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 15;
    const maxWidth = pageWidth - margin * 2;
    let yPosition = margin;
    const lineHeight = 7;
    const sectionSpacing = 5;

    // Split text into lines
    const allLines = doc.splitTextToSize(text, maxWidth);

    doc.setFont("helvetica", "normal");

    // Process lines with special formatting
    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];

      // Check if we need a new page
      if (yPosition > pageHeight - margin - lineHeight) {
        doc.addPage();
        yPosition = margin;
      }

      // Format headers (all caps, underlined)
      if (line === line.toUpperCase() && line.length > 0 && !line.startsWith(' ') && !line.startsWith('[') && !line.includes(':')) {
        if (line.includes('=')) {
          // Main header
          doc.setFontSize(16);
          doc.setFont("helvetica", "bold");
          yPosition += 3;
        } else if (line.includes('-')) {
          // Section header
          doc.setFontSize(12);
          doc.setFont("helvetica", "bold");
          yPosition += sectionSpacing;
        } else {
          // Subsection
          doc.setFontSize(11);
          doc.setFont("helvetica", "bold");
          yPosition += sectionSpacing;
        }
        doc.text(line, margin, yPosition);
        yPosition += lineHeight + 2;
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
      } else if (line.trim().startsWith('Date:')) {
        // Date line
        doc.setFontSize(10);
        doc.setFont("helvetica", "italic");
        doc.text(line, margin, yPosition);
        yPosition += lineHeight;
        doc.setFont("helvetica", "normal");
      } else if (line.trim().startsWith('Name:') || line.trim().startsWith('Age:') ||
        line.trim().startsWith('Location:') || line.trim().startsWith('Email:') ||
        line.trim().startsWith('Phone:')) {
        // Client info lines
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(line, margin, yPosition);
        yPosition += lineHeight;
      } else if (line.trim().startsWith('[') && line.includes(']')) {
        // Conversation transcript entries
        doc.setFontSize(9);
        doc.setFont("helvetica", "normal");
        doc.text(line, margin, yPosition);
        yPosition += lineHeight * 0.9;
      } else if (line.trim().match(/^\d+\./)) {
        // Numbered list items
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(line, margin, yPosition);
        yPosition += lineHeight;
      } else if (line.trim() === '') {
        // Empty line
        yPosition += lineHeight * 0.5;
      } else {
        // Regular text
        doc.setFontSize(10);
        doc.setFont("helvetica", "normal");
        doc.text(line, margin, yPosition);
        yPosition += lineHeight;
      }
    }

    // Generate filename with date
    const dateStr = normalizedReport?.consultationDate
      ? new Date(normalizedReport.consultationDate).toISOString().split('T')[0]
      : new Date().toISOString().split('T')[0];
    const clientName = normalizedReport?.clientInfo?.name
      ? `-${normalizedReport.clientInfo.name.replace(/\s+/g, '-')}`
      : '';
    doc.save(`consultation-report${clientName}-${dateStr}.pdf`);
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // CRITICAL: Clear report data when session changes
  // This ensures old reports are NEVER displayed when a new session starts
  // Each new session (new sessionId) gets a completely fresh report
  useEffect(() => {
    // Clear report data when sessionId changes (new session started)
    setReportData(null);
    reportNoticeShownRef.current = false;
  }, [sessionId]);

  // Initialize messages only once from initialMessages prop (on mount)
  useEffect(() => {
    if (!isInitializedRef.current) {
      if (initialMessages.length > 0) {
        setMessages(initialMessages);
      }
      isInitializedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount - initialMessages dependency intentionally omitted

  // Fetch messages when tab becomes visible (fixes tab switching bug)
  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && agentId && isInitializedRef.current) {
        try {
          // For embed endpoint, GET is not supported, so skip fetching messages
          if (apiEndpoint === "/api/embed/chat") {
            return;
          }
          const response = await fetch(`${apiEndpoint}?agentId=${agentId}`);
          if (response.ok) {
            const data = await response.json();
            if (data.messages && Array.isArray(data.messages)) {
              setMessages(data.messages);
            }
          }
        } catch (error) {
          console.error('Error fetching messages on visibility change:', error);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [agentId]);

  // Load visitor profile for embedded chats
  useEffect(() => {
    if (!isEmbedChat || !visitorId) {
      setProfileLoaded(true);
      return;
    }

    const loadProfile = async () => {
      try {
        const data = await callProfileAction("get_profile");
        const profile = data?.profile || null;
        setProfileData(profile);
        setProfileStage(getNextProfileStage(profile));
      } catch (error) {
        console.error("Error loading visitor profile:", error);
      } finally {
        setProfileLoaded(true);
      }
    };

    loadProfile();
  }, [isEmbedChat, visitorId, sessionId, agentId]);

  // Prompt for profile info after language selection (warm greeting in their language for name)
  useEffect(() => {
    if (!isEmbedChat || !languageConfirmed || !profileLoaded) return;

    if (profileStage && profileStage !== "otp" && profileStage !== lastPromptStage) {
      if (profileStage === "name") {
        const greeting = getGreetingForNamePrompt(selectedLanguage);
        addAssistantMessage(greeting.text, greeting.suggestions.length > 0 ? greeting.suggestions : undefined);
        promptForStage(profileStage);
      } else {
        promptForStage(profileStage);
      }
      setLastPromptStage(profileStage);
      return;
    }

    // Welcome message removed — consultation starts directly at Stage A (concern selection)
    if (!profileStage && profileData?.name && !welcomeShown) {
      setWelcomeShown(true);
    }
  }, [isEmbedChat, languageConfirmed, profileLoaded, profileStage, lastPromptStage, profileData, welcomeShown, messages.length, selectedLanguage]);

  // OTP reminder flow: prompt once, then remind after 2.5 minutes if still pending
  useEffect(() => {
    if (!isEmbedChat || !languageConfirmed || profileStage !== "otp") {
      if (otpReminderRef.current) {
        clearTimeout(otpReminderRef.current);
        otpReminderRef.current = null;
      }
      otpPromptedRef.current = false;
      setOtpPromptedAt(null);
      return;
    }

    if (!otpPromptedRef.current) {
      otpPromptedRef.current = true;
      addAssistantMessage("I sent a 6-digit code to your email. Please enter the OTP to verify.");
      setOtpPromptedAt(Date.now());
    }

    if (otpReminderRef.current) {
      clearTimeout(otpReminderRef.current);
    }

    otpReminderRef.current = setTimeout(() => {
      if (profileStage === "otp") {
        addAssistantMessage("Reminder: please enter the 6-digit OTP sent to your email.");
        setOtpPromptedAt(Date.now());
      }
    }, 150000);

    return () => {
      if (otpReminderRef.current) {
        clearTimeout(otpReminderRef.current);
        otpReminderRef.current = null;
      }
    };
  }, [isEmbedChat, languageConfirmed, profileStage, otpPromptedAt]);

  // Auto-enable chat if profile is already complete (returning visitors)
  useEffect(() => {
    if (!isEmbedChat || languageConfirmed) return;
    if (profileLoaded && !profileStage) {
      setLanguageConfirmed(true);
    }
    if (messages.length > 0) {
      setLanguageConfirmed(true);
    }
  }, [isEmbedChat, languageConfirmed, profileLoaded, profileStage, messages.length]);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      const audio = currentAudioRef.current;
      if (audio instanceof HTMLAudioElement) {
        audio.pause();
        // Clean up blob URL if it exists
        if (audio.src.startsWith('blob:')) {
          URL.revokeObjectURL(audio.src);
        }
        currentAudioRef.current = null;
      }
    };
  }, []);

  // Initialize Web Speech API for speech-to-text
  useEffect(() => {
    if (typeof window !== "undefined" && "webkitSpeechRecognition" in window) {
      const SpeechRecognition =
        (window as any).webkitSpeechRecognition ||
        (window as any).SpeechRecognition;
      recognitionRef.current = new SpeechRecognition();
      recognitionRef.current.continuous = false;
      recognitionRef.current.interimResults = false;

      // Update language when selectedLanguage changes
      const langInfo = getLanguageByCode(selectedLanguage) || getDefaultLanguage();
      recognitionRef.current.lang = langInfo.speechRecognitionLang;

      recognitionRef.current.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setIsListening(false);
        setShowVoicePopup(false); // auto-close popup when done
        voiceAutoListenRef.current = false; // pause auto-listen until AI responds
        void fetch("/api/voice/speech-to-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript,
            language: selectedLanguage,
            model: "web_speech_api",
          }),
        }).catch(() => { });
        // In voice mode, auto-send the transcript; otherwise populate input
        if (chatModeRef.current === 'voice') {
          handleSendMessageRef.current(transcript);
        } else {
          setInput(transcript);
        }
      };

      recognitionRef.current.onerror = () => {
        setIsListening(false);
        setShowVoicePopup(false);
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
        setShowVoicePopup(false);
      };
    }
  }, [selectedLanguage]);

  const handleOtherClick = () => {
    otherModeRef.current = true;
    setInputPlaceholder("Describe your condition or concern...");
    inputRef.current?.focus();
  };

  const handleSendMessage = async (messageText: string) => {
    if (!messageText.trim() || loading) return;

    const userMessage = messageText.trim();
    setInput("");
    otherModeRef.current = false;
    setInputPlaceholder(
      isEmbedChat && !languageConfirmed ? "Select a language to begin..." : "Ask me anything..."
    );
    setLoading(true);

    // ── VOICE MODE: completely separate free-flowing conversation ────────────
    // Bypasses ALL consultation stages, profile intake, product logic
    if (chatModeRef.current === 'voice') {
      const voiceUserMsg: ChatMessageType = {
        id: `voice-user-${Date.now()}`,
        agentId,
        sessionId: sessionId || null,
        visitorId: visitorId || null,
        role: 'user' as const,
        content: userMessage,
        createdAt: new Date(),
        metadata: { source: 'voice' } as any,
      };
      setMessages(prev => [...prev, voiceUserMsg]);

      try {
        const history = messages
          .filter(m => m.role === 'user' || m.role === 'assistant')
          .slice(-20)
          .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        const res = await fetch('/api/voice/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: userMessage,
            language: selectedLanguage,
            conversationHistory: history,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Voice chat failed');

        const voiceAiId = `voice-ai-${Date.now()}`;
        const aiMsg: ChatMessageType = {
          id: voiceAiId,
          agentId,
          sessionId: sessionId || null,
          visitorId: visitorId || null,
          role: 'assistant' as const,
          content: data.response || '',
          createdAt: new Date(),
          metadata: { source: 'voice' } as any,
        };
        setMessages(prev => [...prev, aiMsg]);
        setLoading(false);

        // Auto-speak the AI response then re-enable mic
        if (data.response && voiceModeRef.current) {
          voiceAutoListenRef.current = true;
          setSpeakingMessageId(voiceAiId);
          setIsSpeaking(true);
          const langInfo = getLanguageByCode(selectedLanguage) || getDefaultLanguage();
          fetch('/api/voice/text-to-speech', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: data.response, language: selectedLanguage, voiceId: langInfo.elevenlabsVoiceId }),
          }).then(r => r.blob()).then(blob => {
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            currentAudioRef.current = audio;
            audio.onended = () => {
              setIsSpeaking(false); setSpeakingMessageId(null);
              URL.revokeObjectURL(url); currentAudioRef.current = null;
              if (voiceAutoListenRef.current && recognitionRef.current && voiceModeRef.current) {
                setTimeout(() => {
                  if (voiceAutoListenRef.current && voiceModeRef.current) {
                    try { recognitionRef.current.start(); setIsListening(true); } catch (e) { }
                  }
                }, 500);
              }
            };
            audio.onerror = () => { setIsSpeaking(false); setSpeakingMessageId(null); URL.revokeObjectURL(url); currentAudioRef.current = null; };
            audio.play().catch(() => { });
          }).catch(() => { setIsSpeaking(false); setSpeakingMessageId(null); });
        }
      } catch (err) {
        console.error('[Voice chat]', err);
        setLoading(false);
      }
      return; // Always return — never fall through to consultation/profile logic
    }
    // ── END VOICE MODE ────────────────────────────────────────────────────────

    // Profile intake flow for embedded chats (only "name" at start)
    if (isEmbedChat && languageConfirmed && profileStage) {
      const tempUserMessage: ChatMessageType = {
        id: `temp-${Date.now()}`,
        agentId,
        sessionId: sessionId || null,
        visitorId: visitorId || null,
        role: "user" as const,
        content: userMessage,
        createdAt: new Date(),
        metadata: null,
      };
      setMessages((prev) => [...prev, tempUserMessage]);

      try {
        await handleProfileInput(profileStage, userMessage);
      } catch (error) {
        console.error("Profile flow error:", error);
        addAssistantMessage("Something went wrong. Please try again.");
      } finally {
        setLoading(false);
      }
      return;
    }

    // Add user message to UI immediately
    const tempUserMessage: ChatMessageType = {
      id: `temp-${Date.now()}`,
      agentId,
      sessionId: sessionId || null,
      visitorId: visitorId || null,
      role: "user" as const,
      content: userMessage,
      createdAt: new Date(),
      metadata: null,
    };
    setMessages((prev) => [...prev, tempUserMessage]);

    try {
      // ── DB-driven consultation mode ─────────────────────────────────────
      if (isEmbedChat && chatModeRef.current === 'consultation') {
        const consultBody: any = {
          agentId,
          message: userMessage,
          language: selectedLanguage,
        };
        if (visitorId) consultBody.visitorId = visitorId;
        if (sessionId) consultBody.sessionId = sessionId;
        consultBody.conversationHistory = messages
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content }));

        const consultRes = await fetch('/api/db-consultation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(consultBody),
        });
        const consultData = await consultRes.json();
        if (!consultRes.ok) throw new Error(consultData.error || 'DB consultation failed');

        const timestamp = Date.now();

        // ── Client-side option assignment ──────────────────
        let finalContent = consultData.response || '';
        let finalSuggestions = (consultData.suggestions && Array.isArray(consultData.suggestions) && consultData.suggestions.length > 0)
          ? consultData.suggestions
          : [];

        setMessages((prev) => {
          const filtered = prev.filter((m) => m.id !== tempUserMessage.id);
          const nextMessages: ChatMessageType[] = [
            ...filtered,
            { ...tempUserMessage, id: `user-${timestamp}` },
          ];
          nextMessages.push({
            id: `assistant-${timestamp + 1}`,
            agentId,
            sessionId: sessionId || null,
            visitorId: visitorId || null,
            role: 'assistant' as const,
            content: finalContent,
            createdAt: new Date(),
            metadata: {
              source: 'db-consultation',
              ...(consultData.product ? { productCard: consultData.product } : {}),
              suggestions: finalSuggestions.length > 0
                ? finalSuggestions
                : generateFallbackSuggestions(finalContent, userMessage),
            } as any,
          });
          return nextMessages;
        });

        // ── Show AI-recommended products in the right panel ─────────────
        // The AI decides which products to recommend based on the consultation flow.
        // It outputs a [PRODUCTS] block only when it's ready to recommend.
        // We match those product names against the Shopify catalog.
        const aiRecommendedNames: string[] = Array.isArray(consultData.recommendedProducts)
          ? consultData.recommendedProducts
          : [];

        if (aiRecommendedNames.length > 0) {
          try {
            const shopifyRes = await fetch('/api/shopify/products');
            const shopifyData = await shopifyRes.json();
            const shopifyCatalog: ProductItem[] = Array.isArray(shopifyData.products)
              ? shopifyData.products.map((p: any) => {
                const variants = Array.isArray(p.variants) ? p.variants : [];
                const firstVariant = variants.find((v: any) => v.available !== false) || variants[0];
                return {
                  id: p.id,
                  title: p.title,
                  description: p.description || null,
                  price: p.price || null,
                  url: p.url || '',
                  imageUrl: p.imageUrl || null,
                  features: p.tags || [],
                  variantId: firstVariant?.id || null,
                };
              })
              : [];

            // Match AI-recommended product names against Shopify catalog
            const matched: ProductItem[] = [];
            for (const recName of aiRecommendedNames) {
              const recLower = recName.toLowerCase().trim();
              // Extract significant words from the recommended name (3+ chars)
              const recWords = recLower
                .replace(/[()[\]{},.|]/g, ' ')
                .split(/[\s\-–—_]+/)
                .filter(w => w.length >= 3);

              // Find best Shopify match: prefer exact include, then word overlap
              let bestMatch: ProductItem | null = null;
              let bestOverlap = 0;

              for (const sp of shopifyCatalog) {
                const spLower = sp.title.toLowerCase();
                // Exact substring match (either direction)
                if (spLower.includes(recLower) || recLower.includes(spLower)) {
                  bestMatch = sp;
                  break;
                }
                // Word overlap: count how many significant words match
                const spWords = spLower
                  .replace(/[()[\]{},.|]/g, ' ')
                  .split(/[\s\-–—_]+/)
                  .filter(w => w.length >= 3);
                const overlap = recWords.filter(w => spWords.includes(w)).length;
                if (overlap > bestOverlap) {
                  bestOverlap = overlap;
                  bestMatch = sp;
                }
              }

              // Accept match if at least 2 words overlap (or exact substring match)
              if (bestMatch && (bestOverlap >= 2 || recLower.includes(bestMatch.title.toLowerCase()) || bestMatch.title.toLowerCase().includes(recLower))) {
                const alreadyAdded = matched.some(m => m.id === bestMatch!.id);
                if (!alreadyAdded) matched.push(bestMatch);
              }
            }

            if (matched.length > 0) {
              setProductResults(matched);
              console.log('[Consultation] AI-recommended products displayed:', matched.map(p => p.title));
            }
          } catch (shopifyErr) {
            console.error('[Consultation] Shopify product fetch failed:', shopifyErr);
          }
        }

        setLoading(false);

        // Voice mode: auto-speak AI response then restart mic
        if (voiceModeRef.current && consultData.response) {
          voiceAutoListenRef.current = true;
          const voiceTtsId = `assistant-voice-${Date.now()}`;
          const langInfo = getLanguageByCode(selectedLanguage) || getDefaultLanguage();
          fetch('/api/voice/text-to-speech', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: consultData.response, language: selectedLanguage, voiceId: langInfo.elevenlabsVoiceId }),
          }).then(r => r.blob()).then(blob => {
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            currentAudioRef.current = audio;
            setSpeakingMessageId(voiceTtsId);
            setIsSpeaking(true);
            audio.onended = () => {
              setIsSpeaking(false); setSpeakingMessageId(null);
              URL.revokeObjectURL(url); currentAudioRef.current = null;
              if (voiceAutoListenRef.current && recognitionRef.current) {
                setTimeout(() => {
                  if (voiceAutoListenRef.current && recognitionRef.current) {
                    try { recognitionRef.current.start(); setIsListening(true); } catch (e) { }
                  }
                }, 500);
              }
            };
            audio.onerror = () => { setIsSpeaking(false); setSpeakingMessageId(null); URL.revokeObjectURL(url); currentAudioRef.current = null; };
            audio.play().catch(() => { });
          }).catch(e => console.error('Voice TTS error:', e));
        }
        return;
      }

      // ── Standard chat endpoint ────────────────────────────────────────────
      const requestBody: any = {
        agentId,
        message: userMessage,
        language: selectedLanguage,
      };

      // Include visitorId and sessionId for embedded chats
      if (isEmbedChat) {
        if (visitorId) requestBody.visitorId = visitorId;
        if (sessionId) requestBody.sessionId = sessionId;
      }

      const response = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to send message");
      }

      // CRITICAL: Always use the FRESH report from the API response
      // Each consultation session gets a completely new report - never reuse old reports
      // The backend always generates a fresh report for the current session
      let shouldShowReportNotice = false;
      if (data.report) {
        // Always set the new report data - this replaces any previous report
        // The backend always generates a fresh report for the current session
        const newReport = mergeReportWithProfile(data.report);
        setReportData(newReport);

        // Show report notice for new reports in embedded chats; optionally offer to send report by email
        if (isEmbedChat && !reportNoticeShownRef.current) {
          reportNoticeShownRef.current = true;
          shouldShowReportNotice = true;
        }

        console.log('[AgentChat] Received FRESH consultation report:', {
          sessionId: sessionId,
          visitorId: visitorId,
          consultationDate: newReport?.consultationDate,
          hasTranscript: !!newReport?.conversationTranscript,
          isNewReport: true
        });
      } else {
        // Clear report data if no report in response
        setReportData(null);
      }

      // Update sidebar: final products (Stage E) take priority; contextProducts update it during consultation
      if (data.products && Array.isArray(data.products) && data.products.length > 0) {
        // Final recommended products from chat — sync to right panel immediately
        setProductResults(data.products);
        console.log('[AgentChat] Final products synced to sidebar:', data.products.length);
      } else if (data.contextProducts && Array.isArray(data.contextProducts) && data.contextProducts.length > 0) {
        // Update sidebar panel with context-relevant products during consultation
        // But only if we don't already have final products displayed
        setProductResults(prev => prev.length > 0 && prev.some(p => (p as any)._isFinal) ? prev : data.contextProducts);
        setCurrentCategory(null); // keep in "context" mode — title shows "Suggested for You"
        console.log('[AgentChat] Context products updating sidebar:', data.contextProducts.length);
      }
      // Replace temp message with real one and add assistant response
      setMessages((prev) => {
        const filtered = prev.filter((m) => m.id !== tempUserMessage.id);
        const timestamp = Date.now();
        const nextMessages: ChatMessageType[] = [
          ...filtered,
          {
            ...tempUserMessage,
            id: `user-${timestamp}`,
          },
        ];

        // Consultation phase: show suggestions. Product phase: no suggestions, keep content brief (4ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“5 lines).
        const hasProducts = data.products && Array.isArray(data.products) && data.products.length > 0;
        const truncateToLines = (text: string, maxLines: number) =>
          text.split(/\r?\n/).slice(0, maxLines).join('\n').trim();

        // Add assistant response
        nextMessages.push({
          id: `assistant-${timestamp + 2}`,
          agentId,
          sessionId: sessionId || null,
          visitorId: visitorId || null,
          role: "assistant" as const,
          content: hasProducts ? truncateToLines(data.response, 5) : data.response,
          createdAt: new Date(),
          metadata: {
            contextUsed: data.contextUsed,
            // Only add suggestions during consultation (no products); hide when product recommendations begin
            ...(!hasProducts
              ? {
                suggestions: (data.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0)
                  ? data.suggestions
                  : generateFallbackSuggestions(data.response || '', userMessage),
              }
              : {}),
          },
        });

        // Handle products - add them as a message in the conversation instead of at the top
        if (hasProducts) {
          // Store products for cart functionality
          setProductResults(data.products);
          // Auto-set category from context if not already set
          if (!currentCategory) {
            const lowerMsg = userMessage.toLowerCase();
            if (lowerMsg.includes('energy') || lowerMsg.includes('body') || lowerMsg.includes('nutrition') || lowerMsg.includes('physical')) setCurrentCategory('Physical');
            else if (lowerMsg.includes('stress') || lowerMsg.includes('anxiety') || lowerMsg.includes('sleep') || lowerMsg.includes('mood') || lowerMsg.includes('mental') || lowerMsg.includes('focus')) setCurrentCategory('Mental');
            else if (lowerMsg.includes('routine') || lowerMsg.includes('lifestyle') || lowerMsg.includes('balance') || lowerMsg.includes('habit')) setCurrentCategory('Lifestyle');
            else if (lowerMsg.includes('prevent') || lowerMsg.includes('long-term') || lowerMsg.includes('maintain')) setCurrentCategory('Preventive');
          }

          // Add products as a special assistant message (brief intro, 4ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“5 lines max)
          const productsMessage: ChatMessageType = {
            id: `products-${timestamp + 3}`,
            agentId,
            sessionId: sessionId || null,
            visitorId: visitorId || null,
            role: "assistant" as const,
            content: `I found ${data.products.length} product${data.products.length > 1 ? 's' : ''} that match your needs:`,
            createdAt: new Date(),
            metadata: {
              products: data.products,
              type: 'products'
            } as any,
          };

          nextMessages.push(productsMessage);
        }

        return nextMessages;
      });
    } catch (error) {
      console.error("Chat error:", error);
      setMessages((prev) => prev.filter((m) => m.id !== tempUserMessage.id));
      alert("Failed to send message. Please try again.");
    } finally {
      setLoading(false);
    }
  };
  handleSendMessageRef.current = handleSendMessage;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isEmbedChat && !languageConfirmed) {
      addAssistantMessage("Please select a language to continue.");
      return;
    }
    handleSendMessage(input);
  };

  const handleVoiceInputClick = () => {
    setShowVoicePopup(true);
    if (!isListening && recognitionRef.current) {
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const handleVoiceInput = () => {
    if (!recognitionRef.current) {
      alert("Speech recognition not supported in your browser");
      return;
    }

    // If starting voice from the hub, enter voice consultation mode
    if (!chatMode && languageConfirmed) {
      setChatMode('voice');
      // Speak a welcome greeting, then start listening
      const greetingText: Record<string, string> = {
        en: "Hello! I'm your Wellness AI specialist. Please tell me about your health concern and I'll help you find the right solution.",
        hi: "नमस्ते! मैं आपका वेलनेस विशेषज्ञ हूँ। कृपया अपनी स्वास्थ्य समस्या बताएं।",
        ur: "السلام علیکم! میں آپ کا ویلنیس ماہر ہوں۔ براہ کرم اپنی صحت کی تکلیف بتائیں۔",
        bn: "নমস্কার! আমি আপনার ওয়েলনেস বিশেষজ্ঞ। আপনার স্বাস্থ্য সমস্যা বলুন।",
        ar: "مرحباً! أنا مستشارك لدى Wellness AI. يرجى إخباري بمشكلتك الصحية.",
      };
      const greetMsg = greetingText[selectedLanguage] ?? greetingText.en;
      // Add greeting as assistant message
      const greetId = `assistant-voice-greet-${Date.now()}`;
      setMessages(prev => [...prev, {
        id: greetId, agentId,
        sessionId: sessionId || null, visitorId: visitorId || null,
        role: 'assistant' as const, content: greetMsg,
        createdAt: new Date(), metadata: { source: 'voice-greeting' } as any,
      }]);
      // Speak greeting via TTS, then start listening automatically
      const langInfo2 = getLanguageByCode(selectedLanguage) || getDefaultLanguage();
      voiceAutoListenRef.current = true;
      setIsSpeaking(true); setSpeakingMessageId(greetId);
      fetch('/api/voice/text-to-speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: greetMsg, language: selectedLanguage, voiceId: langInfo2.elevenlabsVoiceId }),
      }).then(r => r.blob()).then(blob => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudioRef.current = audio;
        audio.onended = () => {
          setIsSpeaking(false); setSpeakingMessageId(null);
          URL.revokeObjectURL(url); currentAudioRef.current = null;
          if (voiceAutoListenRef.current && recognitionRef.current) {
            setTimeout(() => {
              if (voiceAutoListenRef.current && recognitionRef.current) {
                try { recognitionRef.current.start(); setIsListening(true); } catch (e) { }
              }
            }, 400);
          }
        };
        audio.onerror = () => { setIsSpeaking(false); setSpeakingMessageId(null); URL.revokeObjectURL(url); currentAudioRef.current = null; };
        audio.play().catch(() => { });
      }).catch(() => { setIsSpeaking(false); setSpeakingMessageId(null); });
      return; // don't start mic yet — wait for TTS greeting to finish
    }

    if (isListening) {
      recognitionRef.current.stop();
      setIsListening(false);
    } else {
      recognitionRef.current.start();
      setIsListening(true);
    }
  };

  const handleSpeak = async (text: string, messageId: string) => {
    // If clicking the same message that's currently speaking
    if (isSpeaking && speakingMessageId === messageId) {
      // If paused, resume; otherwise pause
      const currentAudio = currentAudioRef.current;
      if (currentAudio instanceof HTMLAudioElement) {
        if (isPaused) {
          await currentAudio.play();
          setIsPaused(false);
        } else {
          currentAudio.pause();
          setIsPaused(true);
        }
      }
      return;
    }

    // Stop any existing audio before starting new one (including paused audio)
    const existingAudio = currentAudioRef.current;
    if (existingAudio instanceof HTMLAudioElement) {
      existingAudio.pause();
      existingAudio.currentTime = 0;
      // Clean up blob URL if it exists
      if (existingAudio.src.startsWith('blob:')) {
        URL.revokeObjectURL(existingAudio.src);
      }
      currentAudioRef.current = null;
    }

    // Reset speaking state when switching to a different message
    setIsSpeaking(false);
    setIsPaused(false);
    setSpeakingMessageId(messageId);

    // Set speaking state to true before starting new audio
    setIsSpeaking(true);

    try {
      const langInfo = getLanguageByCode(selectedLanguage) || getDefaultLanguage();
      const response = await fetch("/api/voice/text-to-speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          language: selectedLanguage,
          voiceId: langInfo.elevenlabsVoiceId,
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to generate speech");
      }

      // Create blob URL from streaming response for faster playback
      const blob = await response.blob();
      const audioUrl = URL.createObjectURL(blob);

      // Create and play audio from blob URL
      const audio = new Audio(audioUrl);
      currentAudioRef.current = audio;

      // Set audio properties for faster playback
      audio.preload = 'auto';

      // Handle canplay event - audio is ready to play
      const handleCanPlay = () => {
        audio.play().catch((error) => {
          console.error("Error playing audio:", error);
          setIsSpeaking(false);
          setIsPaused(false);
          setSpeakingMessageId(null);
        });
      };

      // Handle audio end
      audio.onended = () => {
        setIsSpeaking(false);
        setIsPaused(false);
        setSpeakingMessageId(null);
        URL.revokeObjectURL(audioUrl);
        currentAudioRef.current = null;
        // Voice mode: auto-restart mic after AI finishes speaking
        if (voiceAutoListenRef.current && recognitionRef.current) {
          setTimeout(() => {
            if (voiceAutoListenRef.current && recognitionRef.current) {
              try { recognitionRef.current.start(); setIsListening(true); } catch (e) { console.log('mic restart', e); }
            }
          }, 500);
        }
      };

      // Handle audio errors
      audio.onerror = () => {
        setIsSpeaking(false);
        setIsPaused(false);
        setSpeakingMessageId(null);
        URL.revokeObjectURL(audioUrl);
        currentAudioRef.current = null;
        console.error("Audio playback error");
      };

      // Handle pause event
      audio.onpause = () => {
        if (audio.currentTime > 0 && !audio.ended) {
          setIsPaused(true);
        }
      };

      // Handle play event
      audio.onplay = () => {
        setIsPaused(false);
      };

      // Start playing as soon as enough data is buffered
      if (audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
        // Already has enough data, play immediately
        await audio.play();
      } else {
        // Wait for enough data to be buffered, then play
        audio.addEventListener('canplay', handleCanPlay, { once: true });
        // Also try to play immediately in case it's already ready
        audio.play().catch(() => {
          // Will play when canplay fires
        });
      }
    } catch (error) {
      console.error("Text-to-speech error:", error);
      setIsSpeaking(false);
      setIsPaused(false);
      setSpeakingMessageId(null);
      currentAudioRef.current = null;
    }
  };

  const handlePauseResume = () => {
    const currentAudio = currentAudioRef.current;
    if (currentAudio instanceof HTMLAudioElement) {
      if (isPaused) {
        currentAudio.play();
        setIsPaused(false);
      } else {
        currentAudio.pause();
        setIsPaused(true);
      }
    }
  };

  // Languages to show in greeting (English, Hindi, Urdu, Bengali, Arabic)
  // Only English and Hindi are offered as language choices
  const greetingLanguages = ['en', 'hi'].map(code =>
    SUPPORTED_LANGUAGES.find(lang => lang.code === code)
  ).filter(Boolean) as typeof SUPPORTED_LANGUAGES;

  const handleEmbedClose = () => {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: "ai-embed-chat-close" }, "*");
      }
    } catch (error) {
      console.warn("Unable to notify parent window about close:", error);
    }
  };

  const handleLanguageSelect = async (languageCode: string) => {
    setSelectedLanguage(languageCode);
    setLanguageConfirmed(true);

    if (isEmbedChat) {
      // For embedded chat, start profile intake after language selection
      // Skip the hub — go directly to consultation mode
      setChatMode('consultation');
      if (profileLoaded) {
        const nextStage = getNextProfileStage(profileData);
        setProfileStage(nextStage);
      }
      return;
    }

    // For dashboard chat, send a greeting message
    const greetingPrompt = "Hello";
    setLoading(true);

    try {
      const requestBody: any = {
        agentId,
        message: greetingPrompt,
        language: languageCode
      };

      const response = await fetch(apiEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to send greeting");
      }

      // Add greeting messages to the chat
      setMessages([
        {
          id: `user-greeting-${Date.now()}`,
          agentId,
          sessionId: sessionId || null,
          visitorId: visitorId || null,
          role: "user" as const,
          content: greetingPrompt,
          createdAt: new Date(),
          metadata: null,
        },
        {
          id: `assistant-greeting-${Date.now()}`,
          agentId,
          sessionId: sessionId || null,
          visitorId: visitorId || null,
          role: "assistant" as const,
          content: data.response,
          createdAt: new Date(),
          metadata: { contextUsed: data.contextUsed },
        },
      ]);
    } catch (error) {
      console.error("Greeting error:", error);
    } finally {
      setLoading(false);
    }
  };

  // -- FORMAT TIMESTAMP ------------------------------
  const formatTime = (date: Date | string) => {
    try {
      return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  };

  // -- EMBED MODE: Two-panel layout ------------------
  if (isEmbedChat) {

    // Show the landing page when language not confirmed and no messages
    if (!languageConfirmed && messages.length === 0) {
      const langFlags: Record<string, string> = { hi: 'IN' };
      const langGreetings: Record<string, string> = { en: 'Hello', hi: 'नमस्ते' };
      return (
        <div className="wai-frame">
          <div className="wai-landing">

            {/* ── Header bar ── */}
            <div className="wai-landing-header">
              <div className="wai-landing-header-left">
                <div className="wai-landing-avatar">
                  <img src="/Stay-On%20logo.png" alt="Stay-On Wellness" style={{ width: '100%', height: '100%', objectFit: 'contain', transform: 'scale(0.8)' }} />
                </div>
                <span className="wai-landing-header-name">Stay-On Wellness</span>
              </div>
              <div className="wai-landing-header-right">
                <span className="wai-landing-online-badge">
                  <span className="wai-landing-online-dot" />
                  Online
                </span>
                <button type="button" className="wai-landing-menu-btn" aria-label="Menu">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
                </button>
              </div>
            </div>

            {/* ── Centered content ── */}
            <div className="wai-landing-body">
              <div className="wai-landing-lock">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="11" width="14" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
              </div>
              <h1 className="wai-landing-title">Your consultation is private</h1>
              <p className="wai-landing-subtitle">Please choose a language to begin</p>

              <div className="wai-landing-lang-row">
                {greetingLanguages.map((lang) => {
                  const flag = langFlags[lang.code] || lang.code.toUpperCase();
                  const greeting = langGreetings[lang.code] || lang.name;
                  return (
                    <button
                      key={lang.code}
                      type="button"
                      className="wai-landing-lang-card"
                      onClick={() => handleLanguageSelect(lang.code)}
                    >
                      <span className="wai-landing-lang-flag">{flag}</span>
                      <span className="wai-landing-lang-greeting">{greeting}</span>
                      <span className="wai-landing-lang-name">{lang.name}</span>
                    </button>
                  );
                })}
              </div>
            </div>

          </div>

          {/* ── Landing page styles ── */}
          <style>{`
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Inter:wght@400;500;600;700;800;900&family=Dosis:wght@400;600;700;800&family=Montserrat:wght@400;500;600;700;800&display=swap');

            .wai-frame {
              width: 100%;
              height: 100%;
              overflow: hidden;
              display: flex;
              flex-direction: column;
              border-radius: 16px;
              border: 1.5px solid rgba(192,57,43,0.25);
              box-shadow: 0 0 24px rgba(192,57,43,0.18), 0 0 48px rgba(192,57,43,0.07);
            }

            .wai-landing {
              display: flex;
              flex-direction: column;
              width: 100%;
              height: 100%;
              background: linear-gradient(to bottom, rgba(139, 40, 32, 0.85), rgba(92, 21, 16, 0.95)), url('/doctor.png');
              background-size: cover;
              background-position: center;
              font-family: 'Montserrat', 'Dosis', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              overflow: hidden;
              border-radius: 16px;
            }

            /* ── Header ── */
            .wai-landing-header {
              display: flex;
              align-items: center;
              justify-content: space-between;
              padding: 16px 20px 12px;
              flex-shrink: 0;
            }
            .wai-landing-header-left {
              display: flex;
              align-items: center;
              gap: 10px;
            }
            .wai-landing-avatar {
              width: 36px; height: 36px;
              border-radius: 8px;
              background: #fff;
              display: flex; align-items: center; justify-content: center;
              flex-shrink: 0;
            }
            .wai-landing-header-name {
              font-size: 14px;
              font-weight: 700;
              color: #fff;
              letter-spacing: 0.01em;
            }
            .wai-landing-header-right {
              display: flex;
              align-items: center;
              gap: 10px;
            }
            .wai-landing-online-badge {
              display: flex;
              align-items: center;
              gap: 6px;
              font-size: 12px;
              font-weight: 600;
              color: rgba(255,255,255,0.85);
            }
            .wai-landing-online-dot {
              width: 8px; height: 8px;
              border-radius: 50%;
              background: #4ade80;
              box-shadow: 0 0 6px rgba(74,222,128,0.5);
              animation: wai-landing-pulse 2s ease-in-out infinite;
            }
            @keyframes wai-landing-pulse {
              0%, 100% { box-shadow: 0 0 6px rgba(74,222,128,0.5); }
              50% { box-shadow: 0 0 12px rgba(74,222,128,0.3), 0 0 0 4px rgba(74,222,128,0.1); }
            }
            .wai-landing-menu-btn {
              background: none;
              border: none;
              cursor: pointer;
              padding: 4px;
              display: flex;
              align-items: center;
              opacity: 0.7;
              transition: opacity 0.15s;
            }
            .wai-landing-menu-btn:hover { opacity: 1; }

            /* ── Body (centered content) ── */
            .wai-landing-body {
              flex: 1;
              display: flex;
              flex-direction: column;
              align-items: center;
              justify-content: center;
              padding: 0 24px;
              text-align: center;
              gap: 0;
            }
            .wai-landing-lock {
              width: 64px;
              height: 64px;
              border-radius: 50%;
              border: 1.5px solid rgba(255, 255, 255, 0.3);
              display: flex;
              align-items: center;
              justify-content: center;
              margin-bottom: 24px;
            }
            .wai-landing-title {
              margin: 0 0 12px;
              font-family: 'Playfair Display', 'Montserrat', serif;
              font-size: 34px;
              font-weight: 600;
              color: #fff;
              letter-spacing: 0.01em;
            }
            .wai-landing-subtitle {
              margin: 0 0 40px;
              font-size: 16px;
              font-weight: 400;
              color: rgba(255,255,255,0.8);
              letter-spacing: 0.5px;
            }

            /* ── Language cards row ── */
            .wai-landing-lang-row {
              display: flex;
              gap: 16px;
              justify-content: center;
              width: 100%;
              max-width: 420px;
            }
            .wai-landing-lang-card {
              flex: 1;
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 6px;
              padding: 24px 20px;
              border-radius: 16px;
              border: 1px solid rgba(255, 255, 255, 0.25);
              background: rgba(255, 255, 255, 0.05);
              backdrop-filter: blur(16px);
              -webkit-backdrop-filter: blur(16px);
              cursor: pointer;
              transition: all 0.3s ease;
              text-align: center;
              box-shadow: 0 4px 24px rgba(0, 0, 0, 0.1);
            }
            .wai-landing-lang-card:hover {
              background: rgba(255,255,255,0.14);
              border-color: rgba(255,255,255,0.3);
              transform: translateY(-2px);
              box-shadow: 0 8px 24px rgba(0,0,0,0.2);
            }
            .wai-landing-lang-card:active {
              transform: translateY(0);
            }
            .wai-landing-lang-flag {
              font-size: 16px;
              font-weight: 700;
              color: rgba(255,255,255,0.9);
              letter-spacing: 0.05em;
              text-transform: uppercase;
              margin-bottom: 4px;
            }
            .wai-landing-lang-greeting {
              font-size: 26px;
              font-family: 'Playfair Display', serif;
              font-weight: 600;
              color: #fff;
              margin-bottom: 2px;
            }
            .wai-landing-lang-name {
              font-size: 13px;
              color: rgba(255,255,255,0.7);
              font-weight: 400;
            }

            /* ── Mobile ── */
            @media (max-width: 600px) {
              .wai-frame {
                border-radius: 0;
                border: none;
                box-shadow: none;
              }
              .wai-landing {
                border-radius: 0;
              }
              .wai-landing-header {
                padding: 14px 16px 10px;
              }
              .wai-landing-avatar {
                width: 32px; height: 32px;
              }
              .wai-landing-avatar svg {
                width: 15px; height: 15px;
              }
              .wai-landing-header-name {
                font-size: 13px;
              }
              .wai-landing-title {
                font-size: 26px;
              }
              .wai-landing-subtitle {
                font-size: 14px;
                margin-bottom: 32px;
              }
              .wai-landing-lang-row {
                gap: 12px;
                max-width: 320px;
                padding: 0 4px;
              }
              .wai-landing-lang-card {
                padding: 20px 12px;
                border-radius: 14px;
              }
              .wai-landing-lang-flag {
                font-size: 14px;
              }
              .wai-landing-lang-greeting {
                font-size: 22px;
              }
            }

            @media (max-width: 380px) {
              .wai-landing-title {
                font-size: 26px;
              }
              .wai-landing-subtitle {
                font-size: 12px;
                margin-bottom: 24px;
              }
              .wai-landing-lang-row {
                gap: 10px;
              }
              .wai-landing-lang-card {
                padding: 16px 10px 14px;
              }
            }
          `}</style>
        </div>
      );
    }

    return (
      <div className="wai-frame">
        <div className="wai-root">

          {/* ─ Header (always visible, lives outside panels for mobile) ─ */}
          <div className="wai-header">
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <div className="wai-avatar">
                <img src="/Stay-On%20logo.png" alt="Stay-On" style={{ width: '28px', height: '28px', objectFit: 'contain', borderRadius: '6px' }} />
              </div>
              <span className="wai-online-dot" />
            </div>
            <div style={{ flex: 1 }}>
              <p className="wai-agent-name">Stay-On Wellness</p>
              <p className="wai-agent-status">● Online - ready to Talk</p>
            </div>
            {/* Mobile: Chat/Picks tab switcher (shown after language confirmed) */}
            {languageConfirmed && (
              <div className="wai-mobile-tabs">
                <button type="button"
                  className={`wai-mobile-tab${mobileTab === 'chat' ? ' wai-mobile-tab-active' : ''}`}
                  onClick={() => setMobileTab('chat')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
                  Chat
                </button>
                <button type="button"
                  className={`wai-mobile-tab${mobileTab === 'picks' ? ' wai-mobile-tab-active' : ''}`}
                  onClick={() => setMobileTab('picks')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z" /></svg>
                  Picks
                </button>
              </div>
            )}
          </div>

          {/* ═══ Landing Hub (after language, before mode selection) ═══ */}
          {languageConfirmed && !chatMode && (
            <div className="wai-hub">
              <div className="wai-hub-inner">

                {/* Hub heading */}
                <div className="wai-hub-heading">
                  <div className="wai-hub-logo-dot" />
                  <p className="wai-hub-tagline">How can we help you today?</p>
                </div>

                {/* ── Card 1: Consultation ── */}
                <button
                  type="button"
                  className="wai-hub-card wai-hub-card-consult"
                  onClick={() => setChatMode('consultation')}
                >
                  <div className="wai-hub-card-icon-wrap wai-hub-card-icon-consult">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
                    </svg>
                  </div>
                  <div className="wai-hub-card-body">
                    <p className="wai-hub-card-title">Personalized Consultation</p>
                    <p className="wai-hub-card-desc">Talk to our AI wellness specialist and get a tailored health plan just for you.</p>
                    <ul className="wai-hub-card-perks">
                      <li>✦ Free personalized assessment</li>
                      <li>✦ Ayurvedic supplement guidance</li>
                      <li>✦ Instant product recommendations</li>
                    </ul>
                  </div>
                  <div className="wai-hub-card-arrow">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </div>
                </button>

                {/* ── Card 2: Offers & Products ── */}
                <button
                  type="button"
                  className="wai-hub-card wai-hub-card-offers"
                  onClick={() => { setChatMode('offers'); setMobileTab('picks'); }}
                >
                  <div className="wai-hub-card-icon-wrap wai-hub-card-icon-offers">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 01-8 0" />
                    </svg>
                  </div>
                  <div className="wai-hub-card-body">
                    <p className="wai-hub-card-title">Offers &amp; Products</p>
                    <p className="wai-hub-card-desc">Browse our full range of Ayurvedic wellness products and exclusive offers.</p>
                    <ul className="wai-hub-card-perks">
                      <li>✦ Premium Ayurvedic formulas</li>
                      <li>✦ Bundle discounts available</li>
                      <li>✦ Fast, trusted delivery</li>
                    </ul>
                  </div>
                  <div className="wai-hub-card-arrow">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14M12 5l7 7-7 7" />
                    </svg>
                  </div>
                </button>

              </div>
            </div>
          )}

          {/* ═══ Panel container (shown after mode is chosen or before language) ═══ */}
          <div className="wai-panels" style={{ display: (!languageConfirmed || chatMode) ? 'flex' : 'none' }}>

            {/* ══ LEFT PANEL: Voice mode ══ */}
            {chatMode === 'voice' && (
              <div className={`wai-voice-panel${mobileTab === 'chat' ? ' wai-mobile-active' : ''}`}>

                {/* ─ Voice transcript area (top) ─ */}
                <div className="wai-voice-transcript">
                  <div className="wai-messages-inner">
                    {messages.length === 0 ? (
                      <div className="wai-voice-empty">
                        <div className="wai-voice-empty-icon">
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#14b8a6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="23" />
                            <line x1="8" y1="23" x2="16" y2="23" />
                          </svg>
                        </div>
                        <p className="wai-voice-empty-text">Tap the microphone below to start speaking</p>
                        <p className="wai-voice-empty-hint">Your conversation will appear here</p>
                      </div>
                    ) : (
                      (() => {
                        const lastAsstId = [...messages].reverse().find(m => m.role === 'assistant')?.id;
                        return messages.map((message) => {
                          const isUser = message.role === 'user';
                          const meta = message.metadata as any;
                          const isProductMsg = meta?.type === 'products';
                          const isLastAssistant = !isUser && message.id === lastAsstId;
                          return (
                            <div key={message.id} className={`wai-msg-row${isUser ? ' wai-msg-user-row' : ''}`}>
                              {!isUser && (
                                <div className="wai-msg-avatar">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="8" r="4" fill="white" opacity="0.9" />
                                    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
                                  </svg>
                                </div>
                              )}
                              <div className={`wai-bubble${isUser ? ' wai-bubble-user' : ' wai-bubble-ai'}`}>
                                {isProductMsg ? (
                                  <p className="wai-bubble-text">✅ {message.content}</p>
                                ) : (
                                  <p className="wai-bubble-text">
                                    {(message.content || '').replace(/^#{1,6}\s+/gm, '').replace(/^[\s>*+-]+\s+/gm, '').replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(.*?)\1/g, '$2')}
                                  </p>
                                )}
                                {!isUser && !isProductMsg && isLastAssistant && Array.isArray(meta?.suggestions) && meta.suggestions.length > 0 && (
                                  <div className="wai-chips">
                                    {meta.suggestions.map((s: any, i: number) => (
                                      <button key={i} type="button" onClick={() => handleSendMessage(s.prompt)} className="wai-chip">{s.label}</button>
                                    ))}
                                    <button type="button" onClick={handleOtherClick} className="wai-chip wai-chip-muted">Other</button>
                                  </div>
                                )}
                                <span className={`wai-time${isUser ? ' wai-time-user' : ''}`}>{formatTime(message.createdAt)}</span>
                              </div>
                            </div>
                          );
                        });
                      })()
                    )}

                    {/* Typing indicator */}
                    {loading && (
                      <div className="wai-msg-row">
                        <div className="wai-msg-avatar">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="8" r="4" fill="white" opacity="0.9" />
                            <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
                          </svg>
                        </div>
                        <div className="wai-bubble wai-bubble-ai wai-typing">
                          <span className="wai-dot" style={{ animationDelay: '0ms' }} />
                          <span className="wai-dot" style={{ animationDelay: '160ms' }} />
                          <span className="wai-dot" style={{ animationDelay: '320ms' }} />
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                </div>

                {/* ─ Voice call control zone ─ */}
                <div className="wai-voice-mic-zone">

                  {/* Status indicator: AI speaking waveform OR listening or idle */}
                  <div className="wai-voice-status-row">
                    {isSpeaking && (
                      <div className="wai-voice-speaking">
                        <span className="wai-wave-bar" style={{ animationDelay: '0ms' }} />
                        <span className="wai-wave-bar" style={{ animationDelay: '80ms' }} />
                        <span className="wai-wave-bar" style={{ animationDelay: '160ms' }} />
                        <span className="wai-wave-bar" style={{ animationDelay: '240ms' }} />
                        <span className="wai-wave-bar" style={{ animationDelay: '320ms' }} />
                        <span className="wai-speaking-label">Specialist is speaking...</span>
                      </div>
                    )}
                    {isListening && !isSpeaking && (
                      <div className="wai-voice-live">
                        <span className="wai-voice-live-dot" />
                        <span className="wai-voice-live-text">Listening to you...</span>
                      </div>
                    )}
                    {loading && !isSpeaking && !isListening && (
                      <div className="wai-voice-live" style={{ background: 'rgba(20,184,166,0.08)', borderColor: 'rgba(20,184,166,0.2)' }}>
                        <span className="wai-voice-live-dot" style={{ background: '#14b8a6', animation: 'wai-voice-blink 0.8s ease-in-out infinite' }} />
                        <span className="wai-voice-live-text" style={{ color: '#0f766e' }}>Thinking...</span>
                      </div>
                    )}
                  </div>

                  {/* Main mic button */}
                  <div className="wai-voice-controls">
                    <button type="button"
                      onClick={() => { voiceAutoListenRef.current = true; handleVoiceInput(); }}
                      disabled={loading || isSpeaking}
                      className={`wai-voice-mic-btn${isListening ? ' wai-voice-mic-active' : ''}${isSpeaking ? ' wai-voice-mic-speaking' : ''}`}>
                      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        {isListening
                          ? <><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>
                          : <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></>}
                      </svg>
                    </button>

                    {/* End call button */}
                    <button type="button" className="wai-voice-end-call"
                      title="End call"
                      onClick={() => {
                        voiceAutoListenRef.current = false;
                        setVoiceCallActive(false);
                        if (recognitionRef.current) { try { recognitionRef.current.stop(); } catch (e) { } }
                        const a = currentAudioRef.current; if (a) { a.pause(); a.currentTime = 0; }
                        setIsListening(false); setIsSpeaking(false);
                        setChatMode('consultation');
                      }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10.68 13.31a16 16 0 003.41 2.6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7 2 2 0 011.72 2v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.42 19.42 0 013.43 9.19 19.79 19.79 0 01.36 .55a2 2 0 012-.27h3a2 2 0 011.72 2c.12.96.34 1.9.7 2.81A2 2 0 017.68 8z" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                      </svg>
                    </button>
                  </div>

                  <p className="wai-voice-mic-hint">
                    {isSpeaking ? 'AI is responding...' : isListening ? 'Tap to stop' : 'Tap microphone to speak'}
                  </p>

                  {/* Switch to text */}
                  <button type="button" className="wai-voice-switch-text"
                    onClick={() => { voiceAutoListenRef.current = false; setChatMode('consultation'); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                    </svg>
                    Switch to text
                  </button>

                  {/* Back to consultation */}
                  <button type="button" className="wai-back-btn" style={{ marginTop: '4px' }}
                    title="Back to consultation"
                    onClick={() => {
                      voiceAutoListenRef.current = false;
                      setVoiceCallActive(false);
                      if (recognitionRef.current) { try { recognitionRef.current.stop(); } catch (e) { } }
                      const a = currentAudioRef.current; if (a) { a.pause(); a.currentTime = 0; }
                      setIsListening(false); setIsSpeaking(false);
                      setChatMode('consultation');
                    }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {/* ══ FULL-SCREEN OFFERS MODE: Combos & Offers only ══ */}
            {chatMode === 'offers' && (
              <div className="wai-offers-fullscreen">
                {/* Header bar */}
                <div className="wai-offers-header">
                  <button type="button" className="wai-offers-back" onClick={() => { setChatMode('consultation'); setDbProducts([]); }}
                    title="Back">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 18l-6-6 6-6" />
                    </svg>
                  </button>
                  <div className="wai-offers-header-text">
                    <p className="wai-offers-title">🎁 Offers & Combos</p>
                    <p className="wai-offers-sub">{dbProductsLoading ? 'Loading...' : `${dbProducts.length} offer${dbProducts.length !== 1 ? 's' : ''} available`}</p>
                  </div>
                </div>

                {/* Product grid / loading / empty */}
                <div className="wai-offers-scroll">

                  {/* ── Promotional Offer Banners ── */}
                  <div className="wai-promo-banners">

                    {/* Banner 1: Free Delivery */}
                    <div className="wai-promo-banner wai-promo-banner-delivery">
                      <div className="wai-promo-icon-wrap wai-promo-icon-delivery">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="1" y="3" width="15" height="13" rx="2" />
                          <path d="M16 8h4l3 5v3h-7V8z" />
                          <circle cx="5.5" cy="18.5" r="2.5" />
                          <circle cx="18.5" cy="18.5" r="2.5" />
                        </svg>
                      </div>
                      <div className="wai-promo-text">
                        <p className="wai-promo-title">Free Delivery</p>
                        <p className="wai-promo-desc">On orders above <strong>₹550</strong></p>
                      </div>
                      <div className="wai-promo-badge wai-promo-badge-delivery">FREE</div>
                    </div>

                    {/* Banner 2: Discount Code */}
                    <div className="wai-promo-banner wai-promo-banner-discount">
                      <div className="wai-promo-icon-wrap wai-promo-icon-discount">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z" />
                          <line x1="7" y1="7" x2="7.01" y2="7" />
                        </svg>
                      </div>
                      <div className="wai-promo-text">
                        <p className="wai-promo-title">Flat 10% Off</p>
                        <p className="wai-promo-desc">Use code <span className="wai-promo-code">SAVE10</span> at checkout</p>
                      </div>
                      <div className="wai-promo-badge wai-promo-badge-discount">10%</div>
                    </div>

                  </div>

                  {dbProductsLoading ? (
                    <div className="wai-offers-loading">
                      <div className="wai-offers-spinner" />
                      <p>Loading offers…</p>
                    </div>
                  ) : dbProducts.length === 0 ? (
                    <div className="wai-offers-empty">
                      <span style={{ fontSize: '36px' }}>🌿</span>
                      <p>No offers found.</p>
                    </div>
                  ) : (
                    <div className="wai-offers-grid">
                      {dbProducts.map((p: any) => {
                        const hasVariants = Array.isArray(p.variants) && p.variants.length > 1;
                        const description = p.description
                          ? p.description.length > 120
                            ? p.description.slice(0, 120) + '…'
                            : p.description
                          : null;

                        // Detect offer/combo from tags
                        const tags: string[] = Array.isArray(p.tags) ? p.tags : [];
                        const isCombo = tags.some((t: string) => /combo|bundle|offer|pack|save|deal/i.test(t));
                        const offerTag = isCombo ? 'Combo Offer' : hasVariants ? 'Multi-Pack' : 'Special';

                        return (
                          <div key={p.id} className="wai-offers-card">
                            {/* Product image */}
                            <div className="wai-offers-card-icon">
                              {p.imageUrl ? (
                                <img
                                  src={p.imageUrl}
                                  alt={p.title}
                                  className="wai-offers-card-img"
                                  onError={(e) => {
                                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                                    const fallback = e.currentTarget.nextElementSibling as HTMLElement;
                                    if (fallback) fallback.style.display = 'flex';
                                  }}
                                />
                              ) : null}
                              <span
                                className="wai-offers-card-icon-fallback"
                                style={{ display: p.imageUrl ? 'none' : 'flex' }}
                              >🌿</span>
                            </div>

                            <div className="wai-offers-card-body">
                              <p className="wai-offers-card-title">{p.title}</p>

                              {/* Description */}
                              {description && (
                                <p style={{ margin: '4px 0 8px', fontSize: '11.5px', lineHeight: '1.5', color: '#4b5563' }}>
                                  {description}
                                </p>
                              )}

                              {/* Tags row */}
                              <div className="wai-offers-card-tags">
                                <span className="wai-offers-tag" style={{ background: 'rgba(20,184,166,0.12)', color: '#0d7060' }}>
                                  {offerTag}
                                </span>
                                {hasVariants && (
                                  <span className="wai-offers-tag" style={{ background: 'rgba(139,92,246,0.1)', color: '#6d28d9' }}>
                                    {p.variants.length} options
                                  </span>
                                )}
                                {tags.slice(0, 2).map((tag: string, i: number) => (
                                  <span key={i} className="wai-offers-tag" style={{ background: 'rgba(249,115,22,0.1)', color: '#c2410c' }}>
                                    {tag}
                                  </span>
                                ))}
                              </div>

                              {/* Variant options */}
                              {hasVariants && (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', margin: '6px 0' }}>
                                  {p.variants.map((v: any, vi: number) => (
                                    <span key={vi} style={{
                                      padding: '2px 8px', borderRadius: '12px', fontSize: '10px', fontWeight: 600,
                                      background: vi === 0 ? 'rgba(20,184,166,0.15)' : 'rgba(107,114,128,0.08)',
                                      color: vi === 0 ? '#0d7060' : '#6b7280',
                                      border: vi === 0 ? '1px solid rgba(20,184,166,0.3)' : '1px solid rgba(107,114,128,0.15)',
                                    }}>
                                      {v.title !== 'Default Title' ? v.title : 'Standard'} · {v.price}
                                    </span>
                                  ))}
                                </div>
                              )}

                              {/* Stars */}
                              <div className="wai-product-stars" style={{ margin: '6px 0 4px' }}>
                                {[1, 2, 3, 4, 5].map(s => (
                                  <svg key={s} width="11" height="11" viewBox="0 0 24 24"
                                    fill={s <= 4 ? '#f59e0b' : 'none'} stroke="#f59e0b" strokeWidth="1.5">
                                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                                  </svg>
                                ))}
                              </div>

                              {/* Price */}
                              <p className="wai-offers-card-price">{p.price || 'Contact for price'}</p>

                              {/* Add to Cart + View Details */}
                              {(() => {
                                // Create ProductItem shape for cart handler
                                const cartProduct: ProductItem = {
                                  id: p.id,
                                  title: p.title,
                                  description: p.description || null,
                                  price: p.price || null,
                                  url: p.url || '',
                                  imageUrl: p.imageUrl || null,
                                  features: tags,
                                  variantId: p.variantId || (p.variants?.[0]?.id) || null,
                                };
                                const inCart = cartItems.find(item => item.product.id === p.id);
                                const isAdding = addingProductIds.has(p.id);
                                return (
                                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'center' }}>
                                    <button type="button"
                                      onClick={() => handleAddToCart(cartProduct, 1)}
                                      disabled={!!inCart || isAdding}
                                      style={{
                                        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
                                        padding: '8px 16px', borderRadius: '22px', border: 'none', cursor: inCart || isAdding ? 'default' : 'pointer',
                                        fontSize: '11.5px', fontWeight: 700, color: '#fff',
                                        background: inCart
                                          ? 'linear-gradient(135deg, #059669, #10b981)'
                                          : isAdding
                                            ? 'linear-gradient(135deg, #6b7280, #9ca3af)'
                                            : 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)',
                                        boxShadow: inCart
                                          ? '0 2px 8px rgba(5,150,105,0.3)'
                                          : '0 2px 8px rgba(20,184,166,0.3)',
                                        transition: 'all 0.2s ease',
                                        opacity: isAdding ? 0.8 : 1,
                                      }}
                                    >
                                      {inCart ? (
                                        <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg> Added</>
                                      ) : isAdding ? (
                                        <><span className="wai-spinner" /> Adding...</>
                                      ) : (
                                        <><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 01-8 0" /></svg> Add to Cart</>
                                      )}
                                    </button>
                                    {p.url && (
                                      <a href={p.url} target="_blank" rel="noopener noreferrer" style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        width: '34px', height: '34px', borderRadius: '50%',
                                        background: 'rgba(20,184,166,0.08)', border: '1px solid rgba(20,184,166,0.2)',
                                        color: '#0f766e', textDecoration: 'none', flexShrink: 0,
                                      }} title="View Details">
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
                                        </svg>
                                      </a>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                          </div>
                        );
                      })}

                      {/* CTA: Need help choosing? */}
                      <div style={{
                        gridColumn: '1 / -1', padding: '20px', borderRadius: '16px',
                        background: 'linear-gradient(135deg, rgba(20,184,166,0.08) 0%, rgba(15,118,110,0.06) 100%)',
                        border: '1px dashed rgba(20,184,166,0.3)', textAlign: 'center',
                      }}>
                        <p style={{ margin: '0 0 6px', fontSize: '14px', fontWeight: 700, color: '#0f766e' }}>
                          🤔 Need help choosing the right product?
                        </p>
                        <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#4b5563' }}>
                          Our AI consultant can analyze your specific needs and recommend the perfect solution for you.
                        </p>
                        <button type="button" onClick={() => { setChatMode('consultation'); setDbProducts([]); }}
                          style={{
                            padding: '8px 24px', borderRadius: '24px', border: 'none', cursor: 'pointer',
                            fontSize: '12px', fontWeight: 700, color: '#fff',
                            background: 'linear-gradient(135deg, #0f766e 0%, #14b8a6 100%)',
                            boxShadow: '0 2px 12px rgba(20,184,166,0.35)',
                            transition: 'transform 0.2s, box-shadow 0.2s',
                          }}
                          onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.05)'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
                        >
                          💬 Start Consultation
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ══ LEFT PANEL: Chat (text consultation & language selection) ══ */}
            {chatMode !== 'voice' && chatMode !== 'offers' && (
              <div className={`wai-chat${mobileTab === 'chat' ? ' wai-mobile-active' : ''}`}
                style={!chatMode ? { width: '100%', borderRight: 'none' } : undefined}>

                {/* ─ Consultation subheader (no back button — direct flow from language selection) ─ */}
                {chatMode === 'consultation' && (
                  <div className="wai-chat-subheader">
                    <span className="wai-chat-subheader-label">💬 Consultation</span>
                  </div>
                )}

                {/* ─ Messages ─ */}
                <div className="wai-messages">
                  <div className="wai-messages-inner">
                    {messages.length === 0 ? (
                      /* If language already confirmed, show a starting state; otherwise show language selector */
                      languageConfirmed ? (
                        <div className="wai-consultation-starting">
                          <div className="wai-typing" style={{ justifyContent: 'center', padding: '32px 20px' }}>
                            <span className="wai-dot" style={{ animationDelay: '0ms' }} />
                            <span className="wai-dot" style={{ animationDelay: '160ms' }} />
                            <span className="wai-dot" style={{ animationDelay: '320ms' }} />
                          </div>
                          <p style={{ margin: '0 0 24px', textAlign: 'center', fontSize: '13px', color: '#9ca3af' }}>
                            Starting your consultation…
                          </p>
                        </div>
                      ) : (
                        <div className="wai-welcome">
                          <div className="wai-welcome-icon">
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" fill="#14b8a6" />
                            </svg>
                          </div>
                          <h3 className="wai-welcome-title">👋 Hello</h3>
                          <p className="wai-welcome-sub">Choose your preferred language to begin</p>
                          <div className="wai-lang-grid">
                            {greetingLanguages.map((lang) => {
                              const greetingMap: Record<string, string> = {
                                en: 'Hello', hi: 'नमस्ते', ur: 'السلام عليکم', bn: 'নমস্কার', ar: 'مرحباً',
                              };
                              const greeting = greetingMap[lang.code] || lang.name;
                              const isRtl = lang.code === 'ur' || lang.code === 'ar';
                              return (
                                <button key={lang.code} onClick={() => handleLanguageSelect(lang.code)}
                                  dir={isRtl ? 'rtl' : 'ltr'} className="wai-lang-btn">
                                  <span className="wai-lang-greeting">{greeting}</span>
                                  <span className="wai-lang-name">{lang.name}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )
                    ) : (
                      (() => {
                        // Find the last assistant message ID so we only show chips on it
                        const lastAsstId = [...messages].reverse().find(m => m.role === 'assistant')?.id;
                        return messages.map((message) => {
                          const isUser = message.role === 'user';
                          const meta = message.metadata as any;
                          const isProductMsg = meta?.type === 'products';
                          const isLastAssistant = !isUser && message.id === lastAsstId;
                          return (
                            <div key={message.id} className={`wai-msg-row${isUser ? ' wai-msg-user-row' : ''}`}>
                              {!isUser && (
                                <div className="wai-msg-avatar">
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="8" r="4" fill="white" opacity="0.9" />
                                    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
                                  </svg>
                                </div>
                              )}
                              <div className={`wai-bubble${isUser ? ' wai-bubble-user' : ' wai-bubble-ai'}`}>
                                {isProductMsg ? (
                                  <p className="wai-bubble-text">✅ {message.content}</p>
                                ) : (
                                  <p className="wai-bubble-text">
                                    {(message.content || '').replace(/^#{1,6}\s+/gm, '').replace(/^[\s>*+-]+\s+/gm, '').replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(.*?)\1/g, '$2')}
                                  </p>
                                )}
                                {!isUser && !isProductMsg && isLastAssistant && Array.isArray(meta?.suggestions) && meta.suggestions.length > 0 && (
                                  <div className="wai-chips">
                                    {meta.suggestions.map((s: any, i: number) => (
                                      <button key={i} type="button" onClick={() => handleSendMessage(s.prompt)} className="wai-chip">
                                        {s.label}
                                      </button>
                                    ))}
                                    <button type="button" onClick={handleOtherClick} className="wai-chip wai-chip-muted">
                                      Other
                                    </button>
                                  </div>
                                )}

                                <span className={`wai-time${isUser ? ' wai-time-user' : ''}`}>
                                  {formatTime(message.createdAt)}
                                </span>
                              </div>
                            </div>
                          );
                        });
                      })()
                    )}

                    {/* Typing indicator */}
                    {loading && (
                      <div className="wai-msg-row">
                        <div className="wai-msg-avatar">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                            <circle cx="12" cy="8" r="4" fill="white" opacity="0.9" />
                            <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="white" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
                          </svg>
                        </div>
                        <div className="wai-bubble wai-bubble-ai wai-typing">
                          <span className="wai-dot" style={{ animationDelay: '0ms' }} />
                          <span className="wai-dot" style={{ animationDelay: '160ms' }} />
                          <span className="wai-dot" style={{ animationDelay: '320ms' }} />
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} />
                  </div>
                </div>

                {/* ─ Input (hidden on language selection screen) ─ */}
                {languageConfirmed && (
                  <form onSubmit={handleSubmit} className="wai-input-bar">
                    <div className="wai-input-bar-row">
                      {/* Standalone Mic Button with label */}
                      <div className="wai-mic-column">
                        <button type="button" onClick={handleVoiceInputClick} disabled={loading}
                          className={`wai-standalone-mic${isListening ? ' wai-standalone-mic-active' : ''}`}
                          title={isListening ? 'Stop' : 'Talk to Specialist'}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            {isListening
                              ? <><rect x="8" y="8" width="8" height="8" rx="2" /></>
                              : <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></>}
                          </svg>
                        </button>
                        <span className="wai-mic-label">{isListening ? 'Listening...' : <><span>Talk to</span><span>Specialist</span></>}</span>
                      </div>
                      {/* Text input + Send */}
                      <div className="wai-input-group">
                        <div className="wai-input-wrap">
                          <input ref={inputRef} type="text" value={input} onChange={e => setInput(e.target.value)}
                            placeholder={inputPlaceholder}
                            disabled={loading}
                            className="wai-input" />
                          <button type="submit" disabled={loading || !input.trim()}
                            className="wai-send-btn">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                              <path d="M22 2L11 13" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                              <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          </button>
                        </div>
                        <p className="wai-input-hint">Powered by Wellness AI</p>
                      </div>
                    </div>
                  </form>
                )}
              </div>
            )}

            {/* ══ RIGHT PANEL: Sales Agent (shown when chatMode is sales) ══ */}
            {chatMode === 'sales' && (
              <div className={`wai-products${mobileTab === 'picks' ? ' wai-mobile-active' : ''}`}>
                <SalesAgentPanel
                  agentId={agentId}
                  concern={salesConcern}
                  language={selectedLanguage}
                  onAddToCart={(url: string, qty: number) => {
                    window.open(url, '_blank');
                  }}
                  onClose={() => setChatMode('consultation')}
                />
              </div>
            )}

            {/* ══ RIGHT PANEL: Products (shown in consultation + voice modes, NOT in sales) ══ */}
            {chatMode && chatMode !== 'offers' && chatMode !== 'sales' && (
              <div className={`wai-products${mobileTab === 'picks' ? ' wai-mobile-active' : ''}`}>
                {productResults.length === 0 ? (
                  /* Empty state */
                  <>
                    <div className="wai-panel-header">
                      <p className="wai-panel-title">Your Wellness Picks</p>
                      <p className="wai-panel-sub">Products will appear after your consultation</p>
                    </div>
                    <div className="wai-empty-state">
                      <div className="wai-empty-icon">
                        <svg width="44" height="44" viewBox="0 0 60 60" fill="none">
                          <ellipse cx="30" cy="30" rx="18" ry="26" fill="#4a7c6f" transform="rotate(-10 30 30)" opacity="0.85" />
                          <ellipse cx="30" cy="30" rx="10" ry="22" fill="#2d5a4f" transform="rotate(-10 30 30)" opacity="0.6" />
                          <path d="M30 50 Q28 40 30 20" stroke="#1a3a2e" strokeWidth="1.5" strokeLinecap="round" opacity="0.4" />
                        </svg>
                      </div>
                      <h3 className="wai-empty-title">Share your concern</h3>
                      <p className="wai-empty-desc">Tell me how you&apos;re feeling and I&apos;ll find the right wellness products for you.</p>
                      <div className="wai-empty-chips">
                        {['Low Energy', 'Poor Sleep', 'Stress Relief'].map(suggestion => (
                          <button key={suggestion} type="button"
                            onClick={() => { if (languageConfirmed) handleSendMessage(`I have ${suggestion.toLowerCase()} concern`); }}
                            className="wai-empty-chip">
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : (
                  /* Products list */
                  <>
                    <div className="wai-panel-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <p className="wai-panel-title">
                          {currentCategory ? `Recommended for ${currentCategory}` : 'Suggested for You'}
                        </p>
                        {currentCategory ? (
                          <span className="wai-cat-badge">
                            <span className="wai-badge-dot" />
                            {currentCategory}
                          </span>
                        ) : (
                          <span className="wai-cat-badge" style={{ background: 'rgba(20,184,166,0.12)', color: '#0d7060', border: '1px solid rgba(20,184,166,0.25)' }}>
                            <span className="wai-badge-dot" style={{ background: '#14b8a6', animation: 'wai-pulse 1.5s infinite' }} />
                            Live
                          </span>
                        )}
                      </div>
                      <p className="wai-panel-sub">
                        {currentCategory
                          ? `${productResults.length} product${productResults.length !== 1 ? 's' : ''} matched`
                          : 'Updating based on your conversation'}
                      </p>
                    </div>

                    <div className="wai-product-scroll">
                      <div className="wai-product-grid">
                        {groupProductsByBase(productResults).map((group, groupIdx) => {
                          const hasVariants = group.products.length > 1;
                          // Find the selected variant or default to the first product in the group
                          const selectedId = selectedVariants[group.baseKey];
                          const product = hasVariants
                            ? (group.products.find(p => p.id === selectedId) || group.products[0])
                            : group.products[0];
                          const cartItem = cartItems.find(item => item.product.id === product.id);
                          const isAdding = addingProductIds.has(product.id);
                          const isBestMatch = groupIdx === 0;
                          const tags = Array.isArray(product.features) ? product.features.slice(0, 3) : [];
                          const tagPalette = [
                            { bg: 'rgba(20,184,166,0.12)', color: '#0d7060', border: 'rgba(20,184,166,0.22)' },
                            { bg: 'rgba(139,92,246,0.1)', color: '#6d28d9', border: 'rgba(139,92,246,0.2)' },
                            { bg: 'rgba(249,115,22,0.1)', color: '#c2410c', border: 'rgba(249,115,22,0.2)' },
                          ];
                          return (
                            <div key={group.baseKey} className="wai-product-card">
                              {/* Image */}
                              <div className="wai-product-img-wrap">
                                {product.imageUrl ? (
                                  <img src={product.imageUrl} alt={product.title} className="wai-product-img" />
                                ) : (
                                  <div className="wai-product-img-placeholder">🌿</div>
                                )}
                                {isBestMatch && (
                                  <span className="wai-best-badge">★ Best Match</span>
                                )}
                              </div>

                              {/* Details */}
                              <div className="wai-product-body">
                                <p className="wai-product-title">{product.title}</p>

                                {/* Variant chips: shown when multiple duration/pack variants exist */}
                                {hasVariants && (
                                  <div className="wai-variant-chips">
                                    {group.products.map(v => {
                                      const label = getVariantLabel(v.title || '') || v.title;
                                      const isSelected = v.id === product.id;
                                      return (
                                        <button
                                          key={v.id}
                                          type="button"
                                          onClick={() => handleVariantSelect(group.baseKey, v.id)}
                                          className={`wai-variant-chip${isSelected ? ' wai-variant-active' : ''}`}
                                        >
                                          {label}
                                          {v.price && <span className="wai-variant-price">{v.price}</span>}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}

                                {tags.length > 0 && (
                                  <div className="wai-product-tags">
                                    {tags.map((tag: string, i: number) => (
                                      <span key={i} style={{
                                        padding: '2px 8px', borderRadius: '20px',
                                        fontSize: '10px', fontWeight: 600,
                                        background: tagPalette[i % 3].bg,
                                        color: tagPalette[i % 3].color,
                                        border: `1px solid ${tagPalette[i % 3].border}`,
                                      }}>
                                        {tag}
                                      </span>
                                    ))}
                                  </div>
                                )}

                                {product.description && (
                                  <p className="wai-product-desc">{product.description}</p>
                                )}

                                {/* Stars */}
                                <div className="wai-product-stars">
                                  {[1, 2, 3, 4, 5].map(s => (
                                    <svg key={s} width="11" height="11" viewBox="0 0 24 24"
                                      fill={s <= 4 ? '#f59e0b' : 'none'} stroke="#f59e0b" strokeWidth="1.5">
                                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                                    </svg>
                                  ))}
                                </div>

                                {product.price && (
                                  <p className="wai-product-price">{product.price}</p>
                                )}

                                {/* Actions */}
                                <div className="wai-product-actions">
                                  <a href={product.url} target="_blank" rel="noreferrer" className="wai-view-btn" title="View product">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                                    </svg>
                                  </a>
                                  <button type="button" onClick={() => handleAddToCart(product, 1)}
                                    disabled={!!cartItem || isAdding}
                                    className={`wai-cart-btn${cartItem ? ' wai-cart-added' : isAdding ? ' wai-cart-adding' : ''}`}>
                                    {cartItem ? (
                                      <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12" /></svg> Added</>
                                    ) : isAdding ? (
                                      <><span className="wai-spinner" /> Adding...</>
                                    ) : (
                                      <><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 01-8 0" /></svg> Add to Cart</>
                                    )}
                                  </button>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* ── CTA: Get Personalized Plan ── */}
                      {chatMode === 'consultation' && productResults.length > 0 && (
                        <div className="wai-sales-cta-section">
                          <p className="wai-sales-cta-text">Our sales specialist will build your perfect plan</p>
                          <button
                            type="button"
                            className="wai-sales-cta-btn"
                            onClick={() => {
                              const detected = detectSalesConcern(
                                messages
                                  .filter(m => m.role === 'user' || m.role === 'assistant')
                                  .map(m => ({ role: m.role, content: m.content }))
                              );
                              setSalesConcern(detected);
                              setMobileTab('picks');
                              setChatMode('sales');
                            }}
                          >
                            🎯 Get My Personalized Plan
                          </button>
                        </div>
                      )}

                      {/* Cart summary */}
                      {cartItems.length > 0 && (
                        <div className="wai-cart-summary">
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#0f766e" strokeWidth="2"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" /><line x1="3" y1="6" x2="21" y2="6" /><path d="M16 10a4 4 0 01-8 0" /></svg>
                            <span className="wai-cart-count">{cartItems.reduce((s, i) => s + i.quantity, 0)} item{cartItems.reduce((s, i) => s + i.quantity, 0) !== 1 ? 's' : ''} in cart</span>
                          </div>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            {(() => {
                              const cartUrl = cartItems[0]?.product ? (() => { try { return new URL(cartItems[0].product.url).origin + '/cart'; } catch { return '/cart'; } })() : '/cart';
                              return (
                                <a href={cartUrl} target="_blank" rel="noreferrer" className="wai-cart-link">View Cart</a>
                              );
                            })()}
                            {checkoutLink && (
                              <a href={checkoutLink} target="_blank" rel="noreferrer" className="wai-cart-link wai-checkout-link">Checkout →</a>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}{/* end chatMode conditional */}
          </div>{/* end wai-panels */}

          {/* ══ VOICE POPUP OVERLAY ══ */}
          {showVoicePopup && (
            <div className="wai-voice-popup-overlay">
              <div className="wai-voice-popup-modal">
                <button type="button" className="wai-voice-popup-close" onClick={() => {
                  setShowVoicePopup(false);
                  if (isListening && recognitionRef.current) {
                    try { recognitionRef.current.stop(); } catch (e) { }
                    setIsListening(false);
                  }
                }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
                <div className="wai-voice-popup-content">
                  <h3 className="wai-voice-popup-title">Speak Your Concern</h3>
                  <p className="wai-voice-popup-subtitle">I&apos;m listening and ready to help.</p>

                  <div className="wai-voice-popup-mic-wrap">
                    <span className={`wai-voice-popup-ring${isListening ? ' wai-voice-popup-ring-active' : ''}`} />
                    <button type="button" onClick={handleVoiceInput} disabled={loading}
                      className={`wai-voice-popup-mic${isListening ? ' wai-voice-popup-mic-active' : ''}`}
                      title={isListening ? 'Stop recording' : 'Start recording'}>
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        {isListening
                          ? <><rect x="8" y="8" width="8" height="8" rx="2" /></>
                          : <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></>}
                      </svg>
                    </button>
                  </div>

                  <p className={`wai-voice-popup-status${isListening ? ' wai-voice-popup-status-active' : ''}`}>
                    {isListening ? 'Listening... Tap mic to stop' : 'Tap the microphone to speak'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ══ Styles ══ */}
          <style>{`
          @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Dosis:wght@400;600;700;800&family=Montserrat:wght@400;500;600;700;800&display=swap');
          /* ── Outer frame: fills the full iframe ── */
          .wai-frame {
            width: 100%;
            height: 100%;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            border-radius: 20px;
            border: 1px solid rgba(192,57,43,0.12);
            box-shadow: 0 8px 40px rgba(192,57,43,0.12), 0 2px 8px rgba(0,0,0,0.04);
          }

          /* ── Root layout ─────────────────────────────── */
          .wai-root {
            display: flex;
            flex-direction: column;
            flex: 1;
            height: 100%;
            position: relative;
            overflow: hidden;
            background: linear-gradient(145deg, #FEF7F6 0%, #FDF0EE 30%, #FAE5E2 60%, #F5DBD7 100%);
            font-family: 'Inter', 'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            color: #2F3336;
            -webkit-font-smoothing: antialiased;
          }
          .wai-root::before {
            content: ''; position: absolute; top: -40%; right: -20%;
            width: 400px; height: 400px; border-radius: 50%;
            background: radial-gradient(circle, rgba(227,83,83,0.05) 0%, transparent 70%);
            pointer-events: none; z-index: 0;
            animation: wai-orb-float 20s ease-in-out infinite;
          }
          @keyframes wai-orb-float {
            0%, 100% { transform: translate(0, 0) scale(1); }
            50% { transform: translate(30px, -20px) scale(1.08); }
          }

          /* ── Panels container (row on desktop, column on mobile) ── */
          .wai-panels {
            display: flex;
            flex-direction: row;
            flex: 1;
            min-height: 0;
            overflow: hidden;
          }

          /* ── Chat panel (45% of wai-root) ──────────────── */
          .wai-chat {
            display: flex;
            flex-direction: column;
            width: 45%;
            min-width: 260px;
            border-right: 1px solid rgba(192,57,43,0.06);
            background: linear-gradient(180deg, #FEFAFA 0%, #FDF0EE 40%, #FAE8E5 100%);
            flex-shrink: 0;
            position: relative; z-index: 1;
          }

          /* ── Header ──────────────────────────────────── */
          .wai-header {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 14px 16px 12px;
            background: linear-gradient(135deg, #B5322A 0%, #D44840 40%, #C0392B 100%);
            flex-shrink: 0;
            box-shadow: 0 4px 20px rgba(192,57,43,0.3), 0 1px 3px rgba(0,0,0,0.1);
            position: relative; overflow: hidden; z-index: 2;
          }
          .wai-header::after {
            content: ''; position: absolute; inset: 0;
            background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.06) 50%, transparent 100%);
            animation: wai-header-shimmer 6s ease-in-out infinite;
            pointer-events: none;
          }
          @keyframes wai-header-shimmer {
            0%, 100% { transform: translateX(-100%); }
            50% { transform: translateX(100%); }
          }
          .wai-avatar {
            width: 42px; height: 42px; border-radius: 50%;
            background: rgba(255,255,255,0.18);
            border: 2.5px solid rgba(255,255,255,0.45);
            display: flex; align-items: center; justify-content: center;
            backdrop-filter: blur(4px);
            animation: wai-avatar-breathe 3s ease-in-out infinite;
          }
          .wai-avatar img {
            transform: scale(0.8);
          }
          .wai-online-dot {
            position: absolute; bottom: 1px; right: 1px;
            width: 11px; height: 11px;
            background: #4ade80; border-radius: 50%;
            border: 2.5px solid #C0392B;
            box-shadow: 0 0 0 2px rgba(74,222,128,0.25), 0 0 10px rgba(74,222,128,0.5);
            animation: wai-online-pulse 2s ease-in-out infinite;
          }
          @keyframes wai-online-pulse {
            0%, 100% { box-shadow: 0 0 0 2px rgba(74,222,128,0.25), 0 0 10px rgba(74,222,128,0.5); }
            50% { box-shadow: 0 0 0 4px rgba(74,222,128,0.12), 0 0 16px rgba(74,222,128,0.3); }
          }
          .wai-agent-name {
            margin: 0; font-size: 14px; font-weight: 700;
            color: #fff; line-height: 1.3;
            letter-spacing: -0.01em;
          }
          .wai-agent-status {
            margin: 0; font-size: 10px; font-weight: 500;
            color: rgba(255,255,255,0.92); letter-spacing: 0.01em;
          }


          /* ── Messages ────────────────────────────────── */
          .wai-messages {
            flex: 1; overflow-y: auto; min-height: 0;
            padding: 16px 14px;
            background: transparent;
            position: relative; z-index: 1;
          }
          .wai-messages::-webkit-scrollbar { width: 3px; }
          .wai-messages::-webkit-scrollbar-thumb { background: #e8c9be; border-radius: 4px; }
          .wai-messages-inner { display: flex; flex-direction: column; gap: 12px; }

          /* ── Message rows ────────────────────────────── */
          .wai-msg-row { display: flex; align-items: flex-end; gap: 8px; animation: wai-msg-slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
          .wai-msg-user-row { justify-content: flex-end; }
          .wai-msg-avatar {
            width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
            background: linear-gradient(135deg, #2C2C2C 0%, #444 100%);
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 2px 8px rgba(44,44,44,0.2);
            border: 1.5px solid rgba(255,255,255,0.08);
          }

          /* ── Bubbles ─────────────────────────────────── */
          .wai-bubble {
            max-width: 82%; padding: 11px 15px;
            border-radius: 20px; position: relative;
            line-height: 1.65;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
          }
          .wai-bubble:hover { transform: translateY(-1px); }
          .wai-bubble-ai {
            background: rgba(255,255,255,0.85);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(232,224,216,0.6);
            border-bottom-left-radius: 6px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.04), 0 0 0 1px rgba(255,255,255,0.5) inset;
          }
          .wai-bubble-user {
            background: linear-gradient(135deg, #2C2C2C 0%, #3a3a3a 100%);
            border-bottom-right-radius: 6px;
            box-shadow: 0 3px 12px rgba(44,44,44,0.2);
          }
          .wai-bubble-text {
            margin: 0; font-size: 13px; line-height: 1.65;
            white-space: pre-wrap; word-break: break-word;
            letter-spacing: -0.005em;
          }
          .wai-bubble-ai .wai-bubble-text { color: #2C2C2C; }
          .wai-bubble-user .wai-bubble-text { color: #fff; }
          .wai-time { display: block; margin-top: 5px; font-size: 10px; color: #9ca3af; }
          .wai-time-user { color: rgba(255,255,255,0.5); text-align: right; }

          /* ── Typing indicator ────────────────────────── */
          .wai-typing { display: flex; align-items: center; gap: 6px; padding: 12px 16px; }
          .wai-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: linear-gradient(135deg, #C0392B, #E35353);
            animation: wai-bounce 1.4s ease-in-out infinite;
            box-shadow: 0 1px 4px rgba(192,57,43,0.2);
          }
          @keyframes wai-bounce { 0%,80%,100%{transform:translateY(0) scale(0.85);opacity:0.4} 40%{transform:translateY(-8px) scale(1);opacity:1} }

          /* ── Suggestion chips ────────────────────────── */
          .wai-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
          .wai-chip {
            padding: 6px 14px; border-radius: 22px;
            border: 1.5px solid rgba(192,57,43,0.35); background: rgba(255,255,255,0.9);
            color: #b5322a; font-size: 11.5px; font-weight: 600;
            cursor: pointer; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            backdrop-filter: blur(4px);
          }
          .wai-chip:hover {
            background: linear-gradient(135deg, #C0392B, #E35353);
            border-color: transparent; color: #fff;
            transform: translateY(-2px);
            box-shadow: 0 4px 14px rgba(192,57,43,0.25);
          }
          .wai-chip:active { transform: translateY(0) scale(0.97); }
          .wai-chip-muted { border-color: rgba(209,213,219,0.6); background: rgba(249,250,251,0.9); color: #6b7280; }
          .wai-chip-muted:hover { background: linear-gradient(135deg, #6b7280, #9ca3af); border-color: transparent; color: #fff; box-shadow: 0 4px 14px rgba(107,114,128,0.25); }

          /* ── Welcome screen ──────────────────────────── */
          .wai-welcome {
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; padding: 48px 20px; text-align: center; gap: 16px;
            min-height: 65vh;
          }
          .wai-welcome-icon {
            width: 76px; height: 76px; border-radius: 50%;
            background: linear-gradient(135deg, #fce8e4 0%, #f5d0c8 100%);
            display: flex; align-items: center; justify-content: center;
            margin-bottom: 8px; box-shadow: 0 4px 16px rgba(227,83,83,0.15);
          }
          .wai-welcome-icon svg {
            width: 40px; height: 40px;
          }
          .wai-welcome-title { margin: 0; font-size: 24px; font-weight: 800; color: #1A1A1A; font-family: 'Dosis', 'Montserrat', sans-serif; text-transform: uppercase; letter-spacing: 0.05em; }
          .wai-welcome-sub { margin: 0; font-size: 15px; color: #6b7280; line-height: 1.6; }
          .wai-lang-grid { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; margin-top: 16px; }
          .wai-lang-btn {
            display: flex; flex-direction: column; align-items: center; gap: 6px;
            padding: 16px 24px; border-radius: 16px;
            border: 1.5px solid #e5e7eb; background: #fafafa;
            cursor: pointer; transition: all 0.18s;
            min-width: 100px;
          }
          .wai-lang-btn:hover { border-color: #E35353; background: rgba(227,83,83,0.06); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(227,83,83,0.15); }
          .wai-lang-greeting { font-size: 18px; font-weight: 700; color: #111827; }
          .wai-lang-name { font-size: 12px; color: #9ca3af; font-weight: 400; }

          /* ── Input bar ───────────────────────────────── */
          .wai-input-bar {
            flex-shrink: 0; padding: 12px 14px 10px;
            border-top: 1px solid rgba(240,228,221,0.5);
            background: linear-gradient(to top, rgba(250,245,242,0.98) 0%, rgba(254,250,248,0.95) 100%);
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
            position: relative; z-index: 2;
          }

          /* ── Input bar row: mic column + input group ── */
          .wai-input-bar-row {
            display: flex; flex-direction: column; align-items: center; gap: 8px;
          }

          /* ── Mic column: button + label stacked ── */
          .wai-mic-column {
            display: flex; flex-direction: column; align-items: center;
            gap: 4px; flex-shrink: 0;
          }
          .wai-mic-label {
            font-size: 8.5px; font-weight: 600; color: #b5322a;
            text-align: center; line-height: 1.15;
            letter-spacing: 0.02em;
            opacity: 0.8;
            display: flex; flex-direction: column;
            align-items: center; gap: 0;
          }

          /* ── Input group: wrap + hint stacked ── */
          .wai-input-group {
            width: 100%; min-width: 0;
            display: flex; flex-direction: column; gap: 0;
          }

          .wai-input-wrap {
            display: flex; align-items: center; gap: 6px;
            background: rgba(255,255,255,0.95); border: 1.5px solid rgba(221,213,204,0.45);
            border-radius: 26px; padding: 5px 5px 5px 16px;
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 1px 6px rgba(0,0,0,0.03);
          }
          .wai-input-wrap:focus-within {
            border-color: rgba(192,57,43,0.5);
            box-shadow: 0 0 0 3px rgba(192,57,43,0.06), 0 2px 12px rgba(192,57,43,0.06);
            background: #fff;
          }
          .wai-input {
            flex: 1; min-width: 0; border: none; outline: none;
            background: transparent; font-size: 13px; color: #2C2C2C;
            font-family: inherit;
          }
          .wai-input::placeholder { color: #B8AFA6; font-size: 12.5px; }

          /* ── Standalone Mic Button ── */
          .wai-standalone-mic {
            width: 42px; height: 42px; border-radius: 50%;
            background: linear-gradient(145deg, #C0392B 0%, #E74C3C 50%, #D44840 100%);
            border: none; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0; color: #fff;
            box-shadow: 0 4px 16px rgba(192,57,43,0.35);
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
            animation: wai-mic-breathe 3s ease-in-out infinite;
            position: relative;
          }
          .wai-standalone-mic::before {
            content: ''; position: absolute; inset: -5px;
            border-radius: 50%; border: 1.5px solid rgba(192,57,43,0.12);
            animation: wai-mic-ring 3s ease-in-out infinite;
            pointer-events: none;
          }
          .wai-standalone-mic:hover:not(:disabled) {
            transform: scale(1.08);
            box-shadow: 0 6px 22px rgba(192,57,43,0.4);
          }
          .wai-standalone-mic:active:not(:disabled) { transform: scale(0.95); }
          .wai-standalone-mic:disabled { opacity: 0.35; cursor: not-allowed; animation: none; }
          .wai-standalone-mic:disabled::before { animation: none; border-color: transparent; }
          .wai-standalone-mic-active {
            background: linear-gradient(145deg, #ef4444 0%, #dc2626 100%) !important;
            box-shadow: 0 4px 20px rgba(239,68,68,0.45) !important;
            animation: wai-mic-pulse-active 1.2s ease-in-out infinite !important;
          }
          .wai-standalone-mic-active::before {
            border-color: rgba(239,68,68,0.25) !important;
            animation: wai-mic-ring-active 1.2s ease-in-out infinite !important;
          }
          @keyframes wai-mic-breathe {
            0%, 100% { box-shadow: 0 4px 16px rgba(192,57,43,0.35); }
            50% { box-shadow: 0 5px 20px rgba(192,57,43,0.25), 0 0 0 6px rgba(192,57,43,0.04); }
          }
          @keyframes wai-mic-ring {
            0%, 100% { transform: scale(1); opacity: 0.5; }
            50% { transform: scale(1.06); opacity: 0.25; }
          }
          @keyframes wai-mic-pulse-active {
            0%, 100% { box-shadow: 0 4px 20px rgba(239,68,68,0.45); }
            50% { box-shadow: 0 4px 24px rgba(239,68,68,0.55), 0 0 0 8px rgba(239,68,68,0.06); }
          }
          @keyframes wai-mic-ring-active {
            0%, 100% { transform: scale(1); opacity: 0.7; }
            50% { transform: scale(1.12); opacity: 0.15; }
          }

          /* ── Voice Popup Modal ────────── */
          .wai-voice-popup-overlay {
            position: absolute; inset: 0;
            background: rgba(0, 0, 0, 0.45);
            backdrop-filter: blur(8px);
            z-index: 50; display: flex; align-items: center; justify-content: center;
            opacity: 0; animation: wai-popup-fade-in 0.25s ease forwards;
            padding: 20px;
          }
          .wai-voice-popup-modal {
            background: #fff; width: 100%; max-width: 340px;
            border-radius: 24px; padding: 32px 24px;
            box-shadow: 0 12px 48px rgba(0,0,0,0.2);
            position: relative;
            transform: scale(0.95) translateY(10px);
            animation: wai-popup-slide-up 0.3s cubic-bezier(.34,1.56,.64,1) forwards;
            display: flex; flex-direction: column; align-items: center;
          }
          .wai-voice-popup-close {
            position: absolute; top: 16px; right: 16px;
            background: #f3f4f6; border: none; border-radius: 50%;
            width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
            color: #6b7280; cursor: pointer; transition: all 0.2s;
          }
          .wai-voice-popup-close:hover { background: #e5e7eb; color: #111827; }
          .wai-voice-popup-content {
            display: flex; flex-direction: column; align-items: center; width: 100%;
          }
          .wai-voice-popup-title {
            margin: 0 0 6px; font-size: 20px; font-weight: 800; color: #1f2937; text-align: center;
          }
          .wai-voice-popup-subtitle {
            margin: 0 0 32px; font-size: 13px; color: #6b7280; text-align: center;
          }
          .wai-voice-popup-mic-wrap {
            position: relative; width: 100px; height: 100px;
            margin-bottom: 24px; display: flex; align-items: center; justify-content: center;
          }
          .wai-voice-popup-ring {
            position: absolute; inset: 0; border-radius: 50%;
            border: 2px solid rgba(227,83,83,0.3);
            pointer-events: none;
          }
          .wai-voice-popup-ring-active {
            border-color: rgba(227,83,83,0.6);
            animation: wai-voice-ring-pulse 1.2s ease-in-out infinite;
          }
          .wai-voice-popup-mic {
            width: 80px; height: 80px; border-radius: 50%;
            border: none; cursor: pointer;
            background: linear-gradient(135deg, rgba(227,83,83,0.1), rgba(192,57,43,0.06));
            color: #C0392B; box-shadow: 0 4px 16px rgba(227,83,83,0.15);
            display: flex; align-items: center; justify-content: center;
            transition: all 0.3s; position: relative; z-index: 2;
          }
          .wai-voice-popup-mic:hover {
            transform: scale(1.05); box-shadow: 0 6px 24px rgba(227,83,83,0.25);
          }
          .wai-voice-popup-mic-active {
            background: linear-gradient(135deg, #C0392B, #E35353) !important;
            color: #fff !important;
            box-shadow: 0 6px 32px rgba(227,83,83,0.5) !important;
            animation: wai-voice-cta-pulse-active 1.5s ease-in-out infinite !important;
          }
          .wai-voice-popup-status {
            font-size: 13px; font-weight: 600; color: #6b7280; text-align: center;
            transition: color 0.3s;
          }
          .wai-voice-popup-status-active { color: #E35353; }
          
          @keyframes wai-popup-fade-in { to { opacity: 1; } }
          @keyframes wai-popup-slide-up { to { transform: scale(1) translateY(0); } }
          .wai-send-btn {
            width: 36px; height: 36px; border-radius: 50%;
            background: linear-gradient(135deg, #C0392B 0%, #E35353 100%);
            border: none; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            box-shadow: 0 3px 12px rgba(192,57,43,0.3);
          }
          .wai-send-btn:hover:not(:disabled) { transform: scale(1.1); box-shadow: 0 5px 18px rgba(192,57,43,0.4); }
          .wai-send-btn:active:not(:disabled) { transform: scale(0.95); }
          .wai-send-btn:disabled { opacity: 0.3; cursor: not-allowed; }
          .wai-input-hint { margin: 6px auto 0; text-align: center; font-size: 9px; color: #ccc; letter-spacing: 0.03em; font-weight: 400; }

          /* ── Voice panel ───────────────────────────── */
          .wai-voice-panel {
            display: flex; flex-direction: column;
            width: 45%; min-width: 260px;
            border-right: 1px solid #f0e4dd;
            background: #F7F3EE; flex-shrink: 0;
          }
          .wai-voice-transcript {
            flex: 1; overflow-y: auto; min-height: 0;
            padding: 14px 12px;
            background: #F7F3EE;
          }
          .wai-voice-transcript::-webkit-scrollbar { width: 3px; }
          .wai-voice-transcript::-webkit-scrollbar-thumb { background: #e8c9be; border-radius: 4px; }

          /* Empty state */
          .wai-voice-empty {
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; text-align: center; gap: 10px;
            padding: 40px 16px; min-height: 120px;
          }
          .wai-voice-empty-icon {
            width: 56px; height: 56px; border-radius: 50%;
            background: linear-gradient(135deg, #fce8e4 0%, #f5d0c8 100%);
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 4px 16px rgba(227,83,83,0.15);
          }
          .wai-voice-empty-text {
            margin: 0; font-size: 14px; font-weight: 600; color: #374151;
          }
          .wai-voice-empty-hint {
            margin: 0; font-size: 12px; color: #9ca3af;
          }

          /* Mic zone */
          .wai-voice-mic-zone {
            flex-shrink: 0; display: flex; flex-direction: column;
            align-items: center; gap: 12px;
            padding: 24px 16px 20px;
            background: linear-gradient(to top, #FAF5F2 0%, #fff 100%);
            border-top: 1px solid #f0e4dd;
          }
          .wai-voice-mic-btn {
            width: 80px; height: 80px; border-radius: 50%;
            background: linear-gradient(135deg, #E35353 0%, #c43a3a 100%);
            border: none; color: #fff; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 6px 28px rgba(227,83,83,0.35), 0 0 0 6px rgba(227,83,83,0.08);
            transition: all 0.25s;
            animation: wai-voice-breathe 3s ease-in-out infinite;
          }
          .wai-voice-mic-btn:hover:not(:disabled) { transform: scale(1.08); box-shadow: 0 8px 32px rgba(227,83,83,0.45), 0 0 0 8px rgba(227,83,83,0.12); }
          .wai-voice-mic-btn:disabled { opacity: 0.5; cursor: not-allowed; animation: none; }
          .wai-voice-mic-active {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%) !important;
            box-shadow: 0 6px 28px rgba(239,68,68,0.35), 0 0 0 6px rgba(239,68,68,0.12) !important;
            animation: wai-voice-pulse 1.5s ease-in-out infinite !important;
          }
          .wai-voice-mic-hint {
            margin: 0; font-size: 13px; font-weight: 600; color: #6b7280;
          }

          /* Live listening indicator */
          .wai-voice-live {
            display: flex; align-items: center; gap: 6px;
            padding: 6px 14px; border-radius: 20px;
            background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.2);
          }
          .wai-voice-live-dot {
            width: 8px; height: 8px; border-radius: 50%;
            background: #ef4444;
            animation: wai-voice-blink 1s ease-in-out infinite;
          }
          .wai-voice-live-text {
            font-size: 12px; font-weight: 600; color: #dc2626;
          }

          /* Voice call controls row */
          .wai-voice-controls {
            display: flex; align-items: center; gap: 20px;
          }
          .wai-voice-status-row {
            min-height: 36px; display: flex; align-items: center; justify-content: center;
          }
          .wai-voice-speaking {
            display: flex; align-items: center; gap: 6px;
            padding: 6px 16px; border-radius: 20px;
            background: rgba(227,83,83,0.08); border: 1px solid rgba(227,83,83,0.2);
          }
          .wai-wave-bar {
            display: inline-block; width: 3px; border-radius: 3px;
            background: #E35353;
            animation: wai-wave 1s ease-in-out infinite;
          }
          @keyframes wai-wave {
            0%, 100% { height: 6px; opacity: 0.5; }
            50% { height: 18px; opacity: 1; }
          }
          .wai-wave-bar:nth-child(1) { animation-delay: 0ms; }
          .wai-wave-bar:nth-child(2) { animation-delay: 80ms; }
          .wai-wave-bar:nth-child(3) { animation-delay: 160ms; }
          .wai-wave-bar:nth-child(4) { animation-delay: 240ms; }
          .wai-wave-bar:nth-child(5) { animation-delay: 320ms; }
          .wai-speaking-label {
            font-size: 11px; font-weight: 600; color: #E35353; margin-left: 4px;
          }
          .wai-voice-mic-speaking {
            opacity: 0.4; cursor: not-allowed !important;
          }
          /* End call button */
          .wai-voice-end-call {
            width: 54px; height: 54px; border-radius: 50%;
            background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
            border: none; color: #fff; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 4px 16px rgba(220,38,38,0.35);
            transition: all 0.2s;
          }
          .wai-voice-end-call:hover { transform: scale(1.08); box-shadow: 0 6px 20px rgba(220,38,38,0.5); }

          /* Switch to text button */
          .wai-voice-switch-text {
            display: flex; align-items: center; gap: 6px;
            padding: 6px 14px; border-radius: 20px;
            border: 1.5px solid #d1d5db; background: #fff;
            color: #6b7280; font-size: 11.5px; font-weight: 600;
            cursor: pointer; transition: all 0.15s;
          }
          .wai-voice-switch-text:hover {
            border-color: #E35353; color: #E35353;
            background: rgba(227,83,83,0.06);
          }

          /* Voice panel animations */
          @keyframes wai-voice-breathe {
            0%, 100% { box-shadow: 0 6px 28px rgba(227,83,83,0.35), 0 0 0 6px rgba(227,83,83,0.08); }
            50% { box-shadow: 0 6px 28px rgba(227,83,83,0.45), 0 0 0 12px rgba(227,83,83,0.06); }
          }
          @keyframes wai-voice-pulse {
            0%, 100% { box-shadow: 0 6px 28px rgba(239,68,68,0.35), 0 0 0 6px rgba(239,68,68,0.12); }
            50% { box-shadow: 0 6px 28px rgba(239,68,68,0.5), 0 0 0 16px rgba(239,68,68,0.08); }
          }
          @keyframes wai-voice-blink {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
          }

          /* ── Products panel ──────────────────────────── */
          .wai-products {
            flex: 1; display: flex; flex-direction: column;
            overflow: hidden; background: linear-gradient(to bottom, #FAF5F2 0%, #FFF8F5 100%);
            min-width: 0;
          }
          .wai-panel-header {
            padding: 14px 18px 12px; border-bottom: 1px solid #f0ddd5;
            background: rgba(255,255,255,0.7); flex-shrink: 0;
            backdrop-filter: blur(8px);
          }
          .wai-panel-title { margin: 0; font-size: 14px; font-weight: 800; color: #111827; }
          .wai-panel-sub { margin: 3px 0 0; font-size: 11px; color: #6b7280; }
          .wai-cat-badge {
            display: inline-flex; align-items: center; gap: 4px;
            padding: 2px 9px; border-radius: 20px;
            font-size: 10px; font-weight: 700;
            color: #c43a3a; background: rgba(227,83,83,0.1);
            border: 1px solid rgba(227,83,83,0.2);
            text-transform: uppercase; letter-spacing: 0.05em;
          }
          .wai-badge-dot { width: 5px; height: 5px; border-radius: 50%; background: #22c55e; }

          /* ── Empty state ─────────────────────────────── */
          .wai-empty-state {
            flex: 1; display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            padding: 32px 24px; text-align: center; gap: 10px;
            position: relative; z-index: 1;
          }
          .wai-empty-icon {
            width: 88px; height: 88px; border-radius: 50%;
            background: linear-gradient(135deg, #e8e2da 0%, #d4c9bc 100%);
            display: flex; align-items: center; justify-content: center;
            margin-bottom: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);
          }
          .wai-empty-title { margin: 0; font-size: 17px; font-weight: 800; color: #111827; }
          .wai-empty-desc { margin: 0; font-size: 12px; color: #6b7280; max-width: 220px; line-height: 1.7; }
          .wai-empty-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 8px; }
          .wai-empty-chip {
            padding: 8px 18px; border-radius: 24px;
            border: 1.5px solid rgba(209,213,219,0.5); background: rgba(255,255,255,0.9);
            font-size: 12px; font-weight: 600; color: #374151;
            cursor: pointer; transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
            backdrop-filter: blur(4px);
          }
          .wai-empty-chip:hover {
            border-color: transparent; color: #fff;
            background: linear-gradient(135deg, #C0392B, #E35353);
            transform: translateY(-2px);
            box-shadow: 0 4px 16px rgba(227,83,83,0.25);
          }

          /* ── Product grid ────────────────────────────── */
          .wai-product-scroll { flex: 1; overflow-y: auto; padding: 14px; }
          .wai-product-scroll::-webkit-scrollbar { width: 3px; }
          .wai-product-scroll::-webkit-scrollbar-thumb { background: #e8c9be; border-radius: 4px; }
          .wai-product-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; align-content: start; }
          .wai-product-card {
            background: #fff; border-radius: 16px; overflow: hidden;
            border: 1px solid #f0ddd5; display: flex; flex-direction: column;
            box-shadow: 0 2px 12px rgba(0,0,0,0.06); transition: all 0.2s;
          }
          .wai-product-card:hover { transform: translateY(-3px); box-shadow: 0 8px 28px rgba(227,83,83,0.14); border-color: #e8b8ae; }
          .wai-product-img-wrap { position: relative; flex-shrink: 0; }
          .wai-product-img { width: 100%; height: 90px; object-fit: cover; display: block; }
          .wai-product-img-placeholder {
            width: 100%; height: 90px;
            background: linear-gradient(135deg, #fce8e4 0%, #f5d0c8 100%);
            display: flex; align-items: center; justify-content: center;
            font-size: 28px;
          }
          .wai-best-badge {
            position: absolute; top: 8px; left: 8px;
            padding: 3px 9px; border-radius: 20px;
            background: #E35353; color: #fff;
            font-size: 9px; font-weight: 700;
            letter-spacing: 0.02em; box-shadow: 0 2px 6px rgba(227,83,83,0.3);
          }
          .wai-product-body {
            padding: 8px 10px 10px; display: flex;
            flex-direction: column; flex: 1; gap: 3px;
          }
          .wai-product-title {
            margin: 0; font-size: 11.5px; font-weight: 700; color: #111827; line-height: 1.3;
            display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
          }
          .wai-product-tags { display: flex; flex-wrap: wrap; gap: 3px; }
          .wai-variant-chips {
            display: flex; flex-wrap: wrap; gap: 4px; margin: 4px 0;
          }
          .wai-variant-chip {
            padding: 3px 8px; border-radius: 16px;
            font-size: 10px; font-weight: 600; line-height: 1.3;
            border: 1.5px solid #e5e7eb; background: #f9fafb; color: #374151;
            cursor: pointer; transition: all 0.15s ease;
            display: flex; flex-direction: column; align-items: center; gap: 1px;
          }
          .wai-variant-chip:hover {
            border-color: #E35353; background: rgba(227,83,83,0.06); color: #c43a3a;
          }
          .wai-variant-active {
            border-color: #E35353; background: rgba(227,83,83,0.1); color: #c43a3a;
            box-shadow: 0 0 0 1px rgba(227,83,83,0.2);
          }
          .wai-variant-price {
            font-size: 9px; font-weight: 700; color: #c43a3a; opacity: 0.8;
          }
          .wai-product-desc { display: none; }
          .wai-product-stars { display: none; }
          .wai-product-price { margin: 2px 0 0; font-size: 13px; font-weight: 800; color: #E35353; letter-spacing: -0.01em; }
          .wai-product-actions { display: flex; gap: 6px; align-items: center; margin-top: auto; padding-top: 4px; }
          .wai-view-btn {
            width: 34px; height: 34px; border-radius: 10px;
            border: 1.5px solid #f0ddd5; background: #F7F3EE;
            display: flex; align-items: center; justify-content: center;
            color: #6b7280; text-decoration: none; flex-shrink: 0;
            transition: all 0.15s;
          }
          .wai-view-btn:hover { border-color: #E35353; color: #E35353; background: rgba(227,83,83,0.06); }
          .wai-cart-btn {
            flex: 1; height: 34px; border-radius: 10px; border: none;
            background: linear-gradient(135deg, #1A1A1A 0%, #E35353 100%);
            color: #fff; font-size: 11.5px; font-weight: 700;
            display: flex; align-items: center; justify-content: center; gap: 5px;
            cursor: pointer; transition: all 0.15s;
            box-shadow: 0 2px 8px rgba(227,83,83,0.3);
            letter-spacing: 0.01em;
          }
          .wai-cart-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(227,83,83,0.45); }
          .wai-cart-added { background: #f3f4f6 !important; color: #6b7280 !important; box-shadow: none !important; cursor: not-allowed !important; }
          .wai-cart-adding { background: rgba(227,83,83,0.12) !important; color: #c43a3a !important; box-shadow: none !important; cursor: wait !important; }
          .wai-spinner {
            width: 11px; height: 11px; border: 2px solid #E35353;
            border-top-color: transparent; border-radius: 50%;
            display: inline-block; animation: wai-spin 0.7s linear infinite;
          }
          @keyframes wai-spin { to { transform: rotate(360deg); } }
          @keyframes wai-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.75); } }
          @keyframes wai-avatar-breathe {
            0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.15); }
            50% { box-shadow: 0 0 12px 3px rgba(255,255,255,0.25); }
          }
          @keyframes wai-msg-appear {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes wai-msg-slide-in {
            from { opacity: 0; transform: translateY(12px) scale(0.97); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          @keyframes wai-hub-pulse {
            0%, 100% { box-shadow: 0 0 0 8px rgba(227,83,83,0.15), 0 6px 24px rgba(227,83,83,0.3); }
            50% { box-shadow: 0 0 0 16px rgba(227,83,83,0.06), 0 6px 24px rgba(227,83,83,0.15); }
          }
          @keyframes wai-hub-pulse-active {
            0%, 100% { box-shadow: 0 0 0 8px rgba(239,68,68,0.2), 0 6px 20px rgba(239,68,68,0.3); }
            50% { box-shadow: 0 0 0 18px rgba(239,68,68,0.06), 0 6px 20px rgba(239,68,68,0.15); }
          }

          /* -- Offers full-screen ---------------------------------- */
          .wai-offers-fullscreen {
            flex: 1; display: flex; flex-direction: column;
            background: linear-gradient(to bottom, #FAF5F2 0%, #FFF8F5 100%);
            overflow: hidden; min-width: 0;
          }
          .wai-offers-header {
            display: flex; align-items: center; gap: 12px;
            padding: 14px 18px 12px;
            background: rgba(255,255,255,0.85);
            border-bottom: 1px solid #f0ddd5;
            flex-shrink: 0;
            backdrop-filter: blur(8px);
          }
          .wai-offers-back {
            display: flex; align-items: center; justify-content: center;
            width: 32px; height: 32px; border-radius: 50%;
            border: 1.5px solid #d1d5db; background: #fff;
            color: #6b7280; cursor: pointer;
            transition: all 0.15s; flex-shrink: 0;
          }
          .wai-offers-back:hover { border-color: #E35353; color: #E35353; background: rgba(227,83,83,0.06); }
          .wai-offers-header-text { flex: 1; }
          .wai-offers-title { margin: 0; font-size: 14px; font-weight: 800; color: #111827; }
          .wai-offers-sub { margin: 2px 0 0; font-size: 11px; color: #6b7280; }
          .wai-offers-scroll {
            flex: 1; overflow-y: auto;
            padding: 16px;
          }
          .wai-offers-scroll::-webkit-scrollbar { width: 3px; }
          .wai-offers-scroll::-webkit-scrollbar-thumb { background: #e8c9be; border-radius: 4px; }
          .wai-offers-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 14px;
            align-content: start;
          }
          .wai-offers-card {
            background: #fff; border-radius: 16px;
            border: 1.5px solid #f0ddd5;
            display: flex; flex-direction: column;
            overflow: hidden;
            box-shadow: 0 2px 12px rgba(0,0,0,0.06);
            transition: all 0.2s;
          }
          .wai-offers-card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(227,83,83,0.14); border-color: #e8b8ae; }
          .wai-offers-card-icon {
            width: 100%; height: 160px;
            background: linear-gradient(135deg, #fce8e4 0%, #f5d0c8 100%);
            display: flex; align-items: center; justify-content: center;
            font-size: 30px; flex-shrink: 0; overflow: hidden; position: relative;
          }
          .wai-offers-card-img {
            width: 100%; height: 100%;
            object-fit: cover; object-position: center;
            display: block;
          }
          .wai-offers-card-icon-fallback {
            width: 100%; height: 100%;
            align-items: center; justify-content: center;
            font-size: 42px; position: absolute; top: 0; left: 0;
          }
          .wai-offers-card-body {
            padding: 10px 12px 12px;
            display: flex; flex-direction: column; flex: 1; gap: 4px;
          }
          .wai-offers-card-title {
            margin: 0; font-size: 12px; font-weight: 700; color: #111827;
            line-height: 1.35;
            display: -webkit-box; -webkit-line-clamp: 2;
            -webkit-box-orient: vertical; overflow: hidden;
          }
          .wai-offers-card-tags { display: flex; flex-wrap: wrap; gap: 3px; margin: 2px 0; }
          .wai-offers-tag {
            padding: 2px 8px; border-radius: 20px;
            font-size: 10px; font-weight: 600;
            text-transform: capitalize;
          }
          .wai-offers-card-meta { margin: 2px 0; font-size: 10.5px; color: #6b7280; }
          .wai-offers-card-price {
            margin: 4px 0 0; font-size: 14px; font-weight: 800;
            color: #E35353; letter-spacing: -0.01em;
          }
          .wai-offers-discount {
            display: inline-block; margin-top: 2px;
            padding: 2px 8px; border-radius: 20px;
            background: rgba(251,191,36,0.15); color: #b45309;
            font-size: 10px; font-weight: 700;
          }
          .wai-offers-loading {
            flex: 1; display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            gap: 14px; padding: 40px 20px;
            color: #6b7280; font-size: 13px;
          }
          .wai-offers-spinner {
            width: 32px; height: 32px; border: 3px solid #f0ddd5;
            border-top-color: #E35353; border-radius: 50%;
            animation: wai-spin 0.8s linear infinite;
          }
          .wai-offers-empty {
            flex: 1; display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            gap: 10px; padding: 40px 20px;
            color: #6b7280; font-size: 13px; text-align: center;
          }

          /* ── Promotional Banners ───────────────────────── */
          .wai-promo-banners {
            display: flex; flex-direction: column; gap: 10px;
            margin-bottom: 16px;
          }
          .wai-promo-banner {
            display: flex; align-items: center; gap: 12px;
            padding: 12px 14px; border-radius: 14px;
            position: relative; overflow: hidden;
            transition: transform 0.2s, box-shadow 0.2s;
            cursor: default;
          }
          .wai-promo-banner:hover { transform: translateY(-2px); }
          .wai-promo-banner::before {
            content: ''; position: absolute; inset: 0;
            background: inherit; opacity: 0; z-index: 0;
          }

          /* Delivery banner */
          .wai-promo-banner-delivery {
            background: linear-gradient(120deg, #fff7ed 0%, #ffedd5 60%, #fed7aa 100%);
            border: 1.5px solid rgba(251,146,60,0.35);
            box-shadow: 0 3px 14px rgba(251,146,60,0.15);
          }
          .wai-promo-banner-delivery:hover { box-shadow: 0 6px 20px rgba(251,146,60,0.28); }
          .wai-promo-icon-delivery {
            background: linear-gradient(135deg, #f97316, #fb923c);
            box-shadow: 0 3px 10px rgba(249,115,22,0.4);
          }
          .wai-promo-badge-delivery {
            background: linear-gradient(135deg, #f97316, #fb923c);
            box-shadow: 0 2px 8px rgba(249,115,22,0.35);
          }

          /* Discount banner */
          .wai-promo-banner-discount {
            background: linear-gradient(120deg, #fdf4ff 0%, #fae8ff 60%, #f3e8ff 100%);
            border: 1.5px solid rgba(192,132,252,0.35);
            box-shadow: 0 3px 14px rgba(168,85,247,0.12);
          }
          .wai-promo-banner-discount:hover { box-shadow: 0 6px 20px rgba(168,85,247,0.25); }
          .wai-promo-icon-discount {
            background: linear-gradient(135deg, #9333ea, #a855f7);
            box-shadow: 0 3px 10px rgba(147,51,234,0.4);
          }
          .wai-promo-badge-discount {
            background: linear-gradient(135deg, #9333ea, #a855f7);
            box-shadow: 0 2px 8px rgba(147,51,234,0.35);
          }

          /* Shared icon + badge + text */
          .wai-promo-icon-wrap {
            width: 40px; height: 40px; border-radius: 12px;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0; color: #fff;
          }
          .wai-promo-text { flex: 1; min-width: 0; }
          .wai-promo-title {
            margin: 0; font-size: 13px; font-weight: 800;
            color: #111827; letter-spacing: -0.01em;
          }
          .wai-promo-desc {
            margin: 2px 0 0; font-size: 11px; color: #6b7280; line-height: 1.4;
          }
          .wai-promo-code {
            display: inline-block;
            padding: 1px 7px; border-radius: 6px;
            background: rgba(147,51,234,0.12); color: #7e22ce;
            font-family: monospace; font-weight: 700; font-size: 11px;
            border: 1px dashed rgba(147,51,234,0.35);
            letter-spacing: 0.04em;
          }
          .wai-promo-badge {
            flex-shrink: 0;
            display: flex; align-items: center; justify-content: center;
            min-width: 38px; height: 26px;
            border-radius: 20px; padding: 0 8px;
            font-size: 10px; font-weight: 900;
            color: #fff; letter-spacing: 0.03em;
          }
          @media (max-width: 640px) {
            .wai-offers-grid { grid-template-columns: 1fr !important; gap: 14px; }
            .wai-offers-card-icon { height: 120px !important; font-size: 40px !important; }
            .wai-offers-card-title { font-size: 14px !important; }
            .wai-offers-card-price { font-size: 16px !important; }
            .wai-offers-scroll { padding: 12px 14px !important; }
            .wai-hub-card { padding: 14px 12px !important; }
            .wai-hub-card-icon-wrap { width: 44px !important; height: 44px !important; }
            .wai-hub-card-title { font-size: 13px !important; }
            .wai-hub-card-desc { font-size: 10px !important; }
          }

          /* ── Landing Hub ──────────────────────────────── */
          .wai-hub {
            flex: 1; display: flex; align-items: center; justify-content: center;
            background: linear-gradient(160deg, #FFF0EE 0%, #FAE8E5 40%, #EFD0C9 100%);
            padding: 20px 16px; overflow-y: auto;
          }
          .wai-hub-inner {
            display: flex; flex-direction: column; align-items: stretch;
            gap: 12px; max-width: 400px; width: 100%;
          }

          /* Hub heading */
          .wai-hub-heading {
            display: flex; flex-direction: column; align-items: center;
            gap: 6px; margin-bottom: 6px; text-align: center;
          }
          .wai-hub-logo-dot {
            width: 36px; height: 4px; border-radius: 4px;
            background: linear-gradient(90deg, #E35353, #1A1A1A);
            margin-bottom: 2px;
          }
          .wai-hub-tagline {
            margin: 0; font-size: 15px; font-weight: 700; color: #111827;
            letter-spacing: -0.01em;
          }

          /* Hub hero cards */
          .wai-hub-card {
            display: flex; align-items: center; gap: 14px;
            padding: 18px 16px; border-radius: 20px;
            border: none; text-align: left; cursor: pointer;
            transition: all 0.22s cubic-bezier(.34,1.56,.64,1);
            position: relative; overflow: hidden; width: 100%;
          }
          .wai-hub-card::before {
            content: ''; position: absolute; inset: 0;
            background: rgba(255,255,255,0.18);
            opacity: 0; transition: opacity 0.2s;
          }
          .wai-hub-card:hover { transform: translateY(-3px) scale(1.01); }
          .wai-hub-card:hover::before { opacity: 1; }
          .wai-hub-card:active { transform: scale(0.98); }

          /* Consultation card */
          .wai-hub-card-consult {
            background: linear-gradient(135deg, #1A1A1A 0%, #2F3336 55%, #E35353 100%);
            box-shadow: 0 8px 28px rgba(227,83,83,0.35), 0 2px 8px rgba(0,0,0,0.06);
          }

          /* Offers card */
          .wai-hub-card-offers {
            background: linear-gradient(135deg, #E35353 0%, #c43a3a 55%, #1A1A1A 100%);
            box-shadow: 0 8px 28px rgba(227,83,83,0.32), 0 2px 8px rgba(0,0,0,0.06);
          }

          /* Card icon wrap */
          .wai-hub-card-icon-wrap {
            flex-shrink: 0; width: 52px; height: 52px; border-radius: 14px;
            display: flex; align-items: center; justify-content: center;
          }
          .wai-hub-card-icon-consult {
            background: rgba(255,255,255,0.22); color: #fff;
          }
          .wai-hub-card-icon-offers {
            background: rgba(255,255,255,0.22); color: #fff;
          }

          /* Card body */
          .wai-hub-card-body {
            flex: 1; min-width: 0;
          }
          .wai-hub-card-title {
            margin: 0 0 3px; font-size: 14px; font-weight: 800;
            color: #fff; letter-spacing: -0.01em;
          }
          .wai-hub-card-desc {
            margin: 0 0 8px; font-size: 11px; color: rgba(255,255,255,0.82);
            line-height: 1.5;
          }
          .wai-hub-card-perks {
            margin: 0; padding: 0; list-style: none;
            display: flex; flex-direction: column; gap: 2px;
          }
          .wai-hub-card-perks li {
            font-size: 10px; color: rgba(255,255,255,0.72); font-weight: 600;
          }

          /* Arrow */
          .wai-hub-card-arrow {
            flex-shrink: 0; color: rgba(255,255,255,0.7);
            transition: transform 0.2s;
          }
          .wai-hub-card:hover .wai-hub-card-arrow { transform: translateX(4px); }

          /* ── Cart summary ────────────────────────────── */
          .wai-cart-summary {
            display: flex; align-items: center; justify-content: space-between;
            flex-wrap: wrap; gap: 8px;
            padding: 12px 16px; margin-top: 10px; border-radius: 14px;
            background: linear-gradient(135deg, rgba(227,83,83,0.08) 0%, rgba(227,83,83,0.04) 100%);
            border: 1px solid rgba(227,83,83,0.2);
            box-shadow: 0 2px 8px rgba(227,83,83,0.08);
          }
          .wai-cart-count { font-size: 12px; font-weight: 700; color: #1A1A1A; }
          .wai-cart-link {
            padding: 5px 14px; border-radius: 10px;
            border: 1.5px solid #E35353; font-size: 11.5px; font-weight: 700;
            color: #E35353; background: #fff; text-decoration: none;
            transition: all 0.15s;
          }
          .wai-cart-link:hover { background: #E35353; color: #fff; }
          .wai-checkout-link { background: #1A1A1A; color: #fff; border-color: #1A1A1A; }
          .wai-checkout-link:hover { background: #E35353; border-color: #E35353; }

          /* ── Sales CTA Button ────────────────────────── */
          .wai-sales-cta-section {
            margin-top: 16px; padding: 14px; border-radius: 16px;
            background: linear-gradient(135deg, rgba(227,83,83,0.06) 0%, rgba(227,83,83,0.12) 100%);
            border: 1.5px solid rgba(227,83,83,0.2);
            text-align: center;
          }
          .wai-sales-cta-text {
            margin: 0 0 10px; font-size: 11.5px; color: #6b7280;
            font-weight: 600; line-height: 1.5;
          }
          .wai-sales-cta-btn {
            width: 100%; padding: 12px 16px; border-radius: 14px; border: none;
            background: linear-gradient(135deg, #1A1A1A 0%, #E35353 100%);
            color: #fff; font-size: 13px; font-weight: 800;
            cursor: pointer; transition: all 0.2s;
            box-shadow: 0 4px 16px rgba(227,83,83,0.3);
            letter-spacing: 0.01em;
          }
          .wai-sales-cta-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 24px rgba(227,83,83,0.45);
          }
          .wai-sales-cta-btn:active { transform: scale(0.98); }

          /* ── Header menu button (three dots) ────────── */
          .wai-header-menu {
            display: none; /* hidden on desktop */
            background: none; border: none; cursor: pointer;
            padding: 6px; opacity: 0.85; flex-shrink: 0;
          }

          /* ── Mobile tab switcher ──────────────────────── */
          .wai-mobile-tabs {
            display: none; /* hidden on desktop */
            align-items: center; gap: 4px; flex-shrink: 0;
          }
          .wai-mobile-tab {
            display: flex; align-items: center; gap: 5px;
            padding: 6px 14px; border-radius: 24px;
            border: 1.5px solid rgba(255,255,255,0.25);
            background: rgba(255,255,255,0.08);
            color: rgba(255,255,255,0.7);
            font-size: 12px; font-weight: 600;
            cursor: pointer; transition: all 0.2s; white-space: nowrap;
          }
          .wai-mobile-tab:hover { background: rgba(255,255,255,0.15); }
          .wai-mobile-tab-active {
            background: #fff !important;
            color: #E35353 !important;
            border-color: #fff !important;
            box-shadow: 0 2px 8px rgba(0,0,0,0.12);
          }
          .wai-mobile-tab-active svg { stroke: #E35353; }

          /* ── Chat sub-header (back button bar inside consultation) ── */
          .wai-chat-subheader {
            display: flex; /* visible on all screen widths */
            align-items: center; gap: 10px;
            padding: 10px 16px 8px;
            background: rgba(255,255,255,0.75);
            border-bottom: 1px solid rgba(240,228,221,0.5);
            flex-shrink: 0;
            backdrop-filter: blur(16px);
            -webkit-backdrop-filter: blur(16px);
          }
          .wai-chat-subheader-label {
            font-size: 13px; font-weight: 700; color: #111827;
            flex: 1; letter-spacing: -0.01em;
          }

          /* ── Back button — circular icon style matching wai-offers-back ── */
          .wai-back-btn {
            display: flex; align-items: center; justify-content: center;
            width: 32px; height: 32px; border-radius: 50%;
            border: 1.5px solid #d1d5db; background: #fff;
            color: #6b7280; cursor: pointer;
            transition: all 0.15s; flex-shrink: 0;
          }
          .wai-back-btn:hover {
            border-color: #E35353; color: #E35353;
            background: rgba(227,83,83,0.06);
          }

          /* ── Responsive: Mobile ──────────────────────── */
          @media (max-width: 640px) {
            .wai-frame {
              border-radius: 0; border: none; box-shadow: none;
              /* Fill the full iframe / viewport on mobile */
              height: 100%;
              min-height: 100dvh;
            }
            .wai-root {
              flex: 1 1 0;
              height: 100%;
              min-height: 0;
            }
            .wai-panels {
              flex-direction: column;
              flex: 1 1 0;
              height: 0;       /* forces flex children to obey flex-basis, preventing overflow */
              min-height: 0;
              overflow: hidden;
            }

            /* Header adjustments */
            .wai-header-menu { display: flex; }
            .wai-mobile-tabs { display: flex; }

            /* Hub: mobile adjustments — ensure it fills the screen */
            .wai-hub {
              padding: 16px 14px;
              min-height: 0;
              align-items: center;
              justify-content: center;
              overflow-y: auto;
            }
            .wai-hub-inner { gap: 10px; width: 100%; max-width: 360px; }
            .wai-hub-mic { width: 64px; height: 64px; }
            .wai-hub-mic svg { width: 28px; height: 28px; }
            .wai-hub-actions { gap: 10px; }
            .wai-hub-btn { padding: 14px 10px; border-radius: 14px; }
            .wai-hub-btn-icon { width: 40px; height: 40px; font-size: 20px; }
            .wai-hub-btn-title { font-size: 12px; }
            .wai-hub-btn-desc { font-size: 10px; }

            /* Hub cards: make them a bit more compact on mobile */
            .wai-hub-card { padding: 14px 12px !important; border-radius: 16px !important; }
            .wai-hub-card-icon-wrap { width: 44px !important; height: 44px !important; }
            .wai-hub-card-title { font-size: 13px !important; }
            .wai-hub-card-desc { font-size: 10px !important; }
            .wai-hub-card-perks li { font-size: 9px !important; }

            /* Show back sub-header on mobile in consultation mode */
            /* already visible on desktop too — just shrink it slightly on mobile */
            .wai-chat-subheader { padding: 8px 10px 6px; }

            /* Hide both panels by default on mobile, show only active */
            .wai-chat {
              width: 100% !important; max-width: 100% !important; min-width: unset !important;
              border-right: none !important;
              display: none !important;
              flex: 1 1 auto; min-height: 0; overflow: hidden;
            }
            .wai-products {
              width: 100% !important;
              display: none !important;
              flex: 1 1 auto; min-height: 0;
            }
            .wai-chat.wai-mobile-active { display: flex !important; }
            .wai-products.wai-mobile-active { display: flex !important; }
            .wai-voice-panel {
              width: 100% !important; max-width: 100% !important; min-width: unset !important;
              border-right: none !important;
              display: none !important;
              flex: 1 1 auto; min-height: 0; overflow: hidden;
            }
            .wai-voice-panel.wai-mobile-active { display: flex !important; }
            .wai-voice-mic-btn { width: 68px; height: 68px; }
            .wai-voice-mic-btn svg { width: 30px; height: 30px; }

            /* Voice panel: comfortable mic zone on mobile */
            .wai-voice-mic-zone { padding: 18px 16px 16px; gap: 10px; }

            /* Welcome screen: vertically centered, spacious layout */
            .wai-welcome {
              padding: 32px 20px; gap: 12px; flex: 1; min-height: 0;
              justify-content: flex-start; overflow-y: auto;
            }
            .wai-welcome-icon {
              width: 64px; height: 64px; margin-bottom: 6px;
            }
            .wai-welcome-icon svg { width: 32px; height: 32px; }
            .wai-welcome-title { font-size: 20px; }
            .wai-welcome-sub { font-size: 13px; }
            .wai-lang-grid {
              display: grid !important; grid-template-columns: 1fr 1fr;
              gap: 10px; width: 100%; max-width: 300px;
              margin-top: 14px;
            }
            .wai-lang-btn {
              padding: 14px 10px; border-radius: 16px;
              border: 1.5px solid #e5e7eb; background: #fafafa;
              justify-content: center; width: 100%;
            }
            .wai-lang-btn:last-child:nth-child(odd) {
              grid-column: 1 / -1; max-width: 160px; justify-self: center;
            }
            .wai-lang-greeting { font-size: 17px; }
            .wai-lang-name { font-size: 11px; }

            /* Messages area: ensure it scrolls properly */
            .wai-messages { padding: 12px 10px !important; }

            /* Input bar: match reference design */
            .wai-input-wrap {
              border-radius: 30px; padding: 5px 5px 5px 14px;
            }
            .wai-input { font-size: 13px; }
            .wai-send-btn {
              width: 38px; height: 38px;
            }
            .wai-input-hint { display: none; }
            .wai-input-bar { padding: 8px 10px 10px !important; }

            /* Product grid: single column, centered, larger cards on mobile */
            .wai-product-grid { grid-template-columns: 1fr !important; gap: 14px; max-width: 400px; margin: 0 auto; }
            .wai-product-scroll { display: flex; flex-direction: column; align-items: center; }
            .wai-product-img { height: 160px !important; }
            .wai-product-img-placeholder { height: 160px !important; font-size: 36px !important; }
            .wai-product-body { padding: 12px 14px 14px !important; gap: 5px !important; }
            .wai-product-title { font-size: 14px !important; -webkit-line-clamp: 3 !important; }
            .wai-product-price { font-size: 15px !important; }
            .wai-product-actions { gap: 8px !important; padding-top: 8px !important; }
            .wai-view-btn { width: 40px !important; height: 40px !important; border-radius: 12px !important; }
            .wai-cart-btn { height: 40px !important; font-size: 13px !important; border-radius: 12px !important; }
            .wai-best-badge { font-size: 10px !important; padding: 4px 10px !important; }
            .wai-product-tags { gap: 4px !important; }
            .wai-product-scroll { padding: 12px 16px !important; }

            /* Offers scroll: proper mobile padding */
            .wai-offers-header { padding: 10px 14px 8px !important; }
            .wai-offers-title { font-size: 13px !important; }
          }
        `}</style>
        </div>
      </div>
    );
  }


  // DASHBOARD MODE: original single-column layout
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 min-h-0 bg-gradient-to-b from-teal-50/30 to-white">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 px-4 text-center animate-in fade-in">
            <div className="mb-8 max-w-md">
              <h2 className="text-2xl font-semibold text-gray-900 mb-3">Hello 👋</h2>
              <p className="text-sm text-gray-600 mb-3 leading-relaxed">{"I'm here to help you with a personal consultation."}</p>
              <p className="text-sm text-gray-600 mb-6 font-medium">Which language would you like to continue in?</p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-2">
              {greetingLanguages.map((lang, index) => (
                <span key={lang.code} className="inline-flex items-center">
                  <button onClick={() => handleLanguageSelect(lang.code)}
                    className="text-sm font-medium text-gray-700 hover:text-[#0f766e] hover:underline transition-colors px-3 py-1.5 rounded-lg hover:bg-[rgba(20,184,166,0.12)]">
                    {lang.name}
                  </button>
                  {index < greetingLanguages.length - 1 && <span className="text-gray-300 mx-1">•</span>}
                </span>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              onSpeak={message.role === "assistant" ? (text) => handleSpeak(text, message.id) : undefined}
              onPauseResume={message.role === "assistant" && speakingMessageId === message.id ? handlePauseResume : undefined}
              isSpeaking={speakingMessageId === message.id && isSpeaking}
              isPaused={speakingMessageId === message.id && isPaused}
              onAddToCart={handleAddToCart}
              onUpdateCartQuantity={handleUpdateCartQuantity}
              cartItems={cartItems}
              checkoutLink={checkoutLink}
              onSuggestionClick={(prompt) => handleSendMessage(prompt)}
              onOtherClick={handleOtherClick}
              addingProductIds={addingProductIds}
            />
          ))
        )}
        {loading && (
          <div className="flex justify-start animate-in fade-in">
            <div className="bg-white rounded-2xl px-5 py-3 shadow-sm border border-gray-100">
              <div className="flex space-x-1.5">
                <div className="w-2 h-2 bg-[#14b8a6] rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></div>
                <div className="w-2 h-2 bg-[#14b8a6] rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></div>
                <div className="w-2 h-2 bg-[#14b8a6] rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit}
        className="px-4 md:px-6 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] border-t border-gray-200 bg-white flex-shrink-0 shadow-lg">
        <div className="flex items-center gap-2 max-w-4xl mx-auto">
          <input ref={inputRef} type="text" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder={inputPlaceholder}
            className="flex-1 min-w-0 rounded-lg border-gray-300 text-gray-900 placeholder-gray-400 shadow-sm focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6] focus:ring-offset-0 text-sm border px-3 py-2 transition-all duration-200 bg-gray-50 focus:bg-white"
            disabled={loading} />
          <div className="flex items-center gap-2 flex-shrink-0">
            <VoiceChatButton isListening={isListening} onClick={handleVoiceInput} disabled={loading} />
            <button type="submit" disabled={loading || !input.trim()}
              className="px-3 py-2 sm:px-4 border border-transparent rounded-lg shadow-sm text-sm font-semibold text-white bg-[#14b8a6] hover:bg-[#0f766e] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#14b8a6] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 transform hover:scale-105 active:scale-95">
              Send
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
