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
  // Landing hub mode: null = show hub, 'consultation' = chat mode, 'offers' = show products, 'voice' = voice interaction
  const [chatMode, setChatMode] = useState<'consultation' | 'offers' | 'voice' | null>(null);
  const chatModeRef = useRef(chatMode);
  const handleSendMessageRef = useRef<(msg: string) => void>(() => { });

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
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleCategoryClick = (category: string) => {
    setCurrentCategory(category);
    if (!languageConfirmed) {
      addAssistantMessage("Please select a language to continue.");
      return;
    }
    handleSendMessage(`I need help with ${category.toLowerCase()}`);
  };

  // Keep chatModeRef in sync with chatMode state
  useEffect(() => { chatModeRef.current = chatMode; }, [chatMode]);

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



  const addAssistantMessage = (content: string) => {
    const assistantMessage: ChatMessageType = {
      id: `assistant-local-${Date.now()}`,
      agentId,
      sessionId: sessionId || null,
      visitorId: visitorId || null,
      role: "assistant",
      content,
      createdAt: new Date(),
      metadata: { source: "system" } as any,
    };
    setMessages((prev) => [...prev, assistantMessage]);
  };

  const buildCheckoutLink = (items: CartItem[]) => {
    if (items.length === 0) return null;
    const urls = items.flatMap((item) => Array(item.quantity).fill(item.product.url)).filter(Boolean);
    if (urls.length === 0) return null;
    const origin = (() => { try { return new URL(urls[0]).origin; } catch { return null; } })();
    if (!origin) return null;
    const itemsParam = encodeURIComponent(urls.join("|"));
    return `${origin}/checkout?items=${itemsParam}`;
  };

  // Add item to website's cart via API or form submission
  const addToWebsiteCart = async (product: ProductItem, quantity: number): Promise<boolean> => {
    try {
      const productUrl = new URL(product.url);

      // Extract product ID - try multiple methods
      let productId: string | null = null;

      // Method 1: Try to extract from URL query parameters (e.g., ?product_id=320 or ?id=320)
      const urlParams = new URLSearchParams(productUrl.search);
      productId = urlParams.get('add-to-cart') ||
        urlParams.get('product_id') ||
        urlParams.get('product-id') ||
        urlParams.get('id') ||
        urlParams.get('p') ||
        null;

      // Method 2: Try to extract from URL path (e.g., /product/320 or /product/320/)
      if (!productId) {
        const pathMatch = product.url.match(/\/(?:product|p|item)\/(\d+)(?:\/|$|\?)/i);
        productId = pathMatch ? pathMatch[1] : null;
      }

      // Method 3: Try to fetch product page from frontend (may fail with CORS if cross-origin)
      if (!productId) {
        try {
          const response = await fetch(product.url, {
            method: 'GET',
            credentials: 'include',
            headers: { 'Accept': 'text/html' },
          });
          if (response.ok) {
            const html = await response.text();
            const idPatterns = [
              /data-product-id=["'](\d+)["']/i,
              /<input[^>]*name=["']add-to-cart["'][^>]*value=["'](\d+)["']/i,
              /add-to-cart["']?\s*[:=]\s*["']?(\d+)/i,
            ];
            for (const pattern of idPatterns) {
              const match = html.match(pattern);
              if (match?.[1]) { productId = match[1]; break; }
            }
          }
        } catch {
          console.log(`[Cart] Frontend fetch failed (CORS?), trying server proxy`);
        }
      }

      // Method 4: Server-side proxy - fetches product page and extracts ID (works for slug URLs, no CORS)
      if (!productId) {
        try {
          const res = await fetch('/api/shop/product-id', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: product.url }),
          });
          if (res.ok) {
            const data = await res.json();
            productId = data.productId || null;
          }
        } catch (err) {
          console.log(`[Cart] Server proxy failed:`, err);
        }
      }

      // Never use product.id - it's a document UUID, not a WooCommerce numeric ID
      // WooCommerce requires numeric IDs (e.g. 1670)
      if (!productId || !/^\d+$/.test(productId)) {
        console.error(`[Cart] No valid WooCommerce product ID found for: ${product.url}`);
        return false;
      }

      console.log(`[Cart] Extracted product ID: ${productId} from URL: ${product.url}`);

      // Use full shop URL - /shop/ and /cart exist on the shop domain, not on the chat app
      const shopOrigin = productUrl.origin;
      const addToCartUrl = quantity > 1
        ? `${shopOrigin}/shop/?add-to-cart=${productId}&quantity=${quantity}`
        : `${shopOrigin}/shop/?add-to-cart=${productId}`;

      console.log(`[Cart] Constructed add-to-cart URL: ${addToCartUrl}`);
      console.log(`[Cart] Product ID: ${productId}, Quantity: ${quantity}`);

      // Method 1: Try to fetch the add-to-cart URL directly (GET request)
      try {
        const addResponse = await fetch(addToCartUrl, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'text/html',
          },
          redirect: 'follow',
        });

        if (addResponse.ok || addResponse.redirected || addResponse.status === 200 || addResponse.status === 302) {
          console.log(`[Cart] Successfully added via direct fetch: ${addToCartUrl}`);
          // Wait a moment for cart to process
          await new Promise(resolve => setTimeout(resolve, 1000));
          return true;
        }
      } catch (fetchError) {
        console.log(`[Cart] Direct fetch failed (may be CORS), trying iframe:`, fetchError);
      }

      // Method 2: Open add-to-cart URL in popup (same-origin, adds product when URL loads)
      try {
        const popup = window.open(addToCartUrl, '_cart_add', 'width=1,height=1,left=-9999,top=-9999');
        if (popup) {
          return new Promise((resolve) => {
            setTimeout(() => {
              if (!popup.closed) popup.close();
              console.log(`[Cart] Opened add-to-cart URL in popup: ${addToCartUrl}`);
              resolve(true);
            }, 2000);
          });
        }
      } catch (popupError) {
        console.log(`[Cart] Popup method failed:`, popupError);
      }

      // Method 3: Try client-side form submission (same-origin only; may fail with CORS if cross-origin)
      try {
        const response = await fetch(product.url, {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'text/html',
          },
        });

        if (response.ok) {
          const html = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');

          // Find add-to-cart form
          const addToCartForm = doc.querySelector('form[action*="cart"], form[action*="add"], form[id*="cart"], form[class*="cart"], form[data-product-id]') as HTMLFormElement;

          if (addToCartForm) {
            const formAction = addToCartForm.action || product.url;
            const formMethod = (addToCartForm.method || 'POST').toUpperCase();

            // Collect form data
            const formData = new FormData();

            // Add all existing form fields
            const inputs = addToCartForm.querySelectorAll('input, select, textarea');
            inputs.forEach((input: any) => {
              if (input.name && input.type !== 'submit' && input.type !== 'button') {
                if (input.type === 'checkbox' || input.type === 'radio') {
                  if (input.checked) {
                    formData.append(input.name, input.value || '1');
                  }
                } else {
                  formData.append(input.name, input.value || '');
                }
              }
            });

            // Override quantity if field exists
            if (formData.has('quantity') || formData.has('qty')) {
              formData.set('quantity', quantity.toString());
              formData.set('qty', quantity.toString());
            } else {
              formData.append('quantity', quantity.toString());
            }

            // Try to submit the form
            try {
              const submitResponse = await fetch(formAction, {
                method: formMethod,
                body: formData,
                credentials: 'include',
              });

              if (submitResponse.ok || submitResponse.redirected) {
                console.log(`[Cart] Successfully added via form submission to ${formAction}`);
                return true;
              }
            } catch (formError) {
              console.log(`[Cart] Form submission failed:`, formError);
            }
          }
        }
      } catch (fetchError) {
        console.log(`[Cart] Failed to fetch product page:`, fetchError);
      }

      // Method 2: Use hidden iframe with the properly constructed add-to-cart URL
      // This is the most reliable method for cross-origin requests
      return new Promise((resolve) => {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.style.width = '1px';
        iframe.style.height = '1px';
        iframe.style.position = 'absolute';
        iframe.style.left = '-9999px';
        iframe.style.visibility = 'hidden';
        iframe.src = addToCartUrl;

        let resolved = false;

        // Wait for iframe to load
        iframe.onload = () => {
          if (resolved) return;
          // Give time for the cart to process the add-to-cart request
          setTimeout(() => {
            if (document.body.contains(iframe)) {
              document.body.removeChild(iframe);
            }
            console.log(`[Cart] Successfully loaded add-to-cart URL in iframe: ${addToCartUrl}`);
            resolved = true;
            resolve(true);
          }, 2000); // Wait 2 seconds for cart to process
        };

        iframe.onerror = () => {
          if (resolved) return;
          if (document.body.contains(iframe)) {
            document.body.removeChild(iframe);
          }
          console.log(`[Cart] Iframe error - but request may have succeeded`);
          resolved = true;
          // Still resolve as true because the request might have gone through
          resolve(true);
        };

        document.body.appendChild(iframe);

        // Fallback timeout - give enough time for the cart to process
        setTimeout(() => {
          if (!resolved) {
            if (document.body.contains(iframe)) {
              document.body.removeChild(iframe);
            }
            console.log(`[Cart] Iframe timeout - request should have completed: ${addToCartUrl}`);
            resolved = true;
            resolve(true);
          }
        }, 3000);
      });
    } catch (error) {
      console.error('[Cart] Error adding to website cart:', error);
      return false;
    }
  };

  const handleAddToCart = async (product: ProductItem, quantity: number = 1) => {
    if (quantity < 1) return;

    // Show loading during add (4-5 seconds)
    setAddingProductIds((prev) => new Set(prev).add(product.id));

    try {
      // Add to website's cart first (takes 4-5 seconds)
      await addToWebsiteCart(product, quantity);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      setAddingProductIds((prev) => {
        const next = new Set(prev);
        next.delete(product.id);
        return next;
      });
      // Only update cart and show View Cart/Checkout after add completes
      setCartItems((prev) => {
        const existing = prev.find((item) => item.product.id === product.id);
        if (existing) {
          return prev.map((item) =>
            item.product.id === product.id ? { ...item, quantity } : item
          );
        }
        return [...prev, { product, quantity }];
      });
    }
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
      namePrompt: { en: "What should I call you?", hi: "आपका नाम क्या है?", ur: "آپ کا نام کیا ہے؟", bn: "আপনার নাম কী?", ar: "ما اسمك؟" },
      emailPrompt: { en: "Please enter your email address to continue.", hi: "कृपया अपना ईमेल पता दर्ज करें।", ur: "براہ کرم اپنا ای میل پتہ درج کریں۔", bn: "অনুগ্রহ করে আপনার ইমেইল ঠিকানা দিন।", ar: "يرجى إدخال عنوان بريدك الإلكتروني للمتابعة." },
      otpSent: { en: "I sent a 6-digit code to your email. Please enter the OTP to verify.", hi: "मैंने आपके ईमेल पर एक 6-अंकीय कोड भेजा है। कृपया OTP दर्ज करें।", ur: "میں نے آپ کی ای میل پر 6 ہندسوں کا کوڈ بھیجا ہے۔ OTP درج کریں۔", bn: "আমি আপনার ইমেইলে 6-সংখ্যার কোড পাঠিয়েছি। OTP লিখুন।", ar: "أرسلت رمزاً من 6 أرقام إلى بريدك. أدخل OTP للتحقق." },
      otpReminder: { en: "Reminder: please enter the 6-digit OTP sent to your email.", hi: "याद दिलाएं: OTP दर्ज करें।", ur: "یاد دہانی: OTP درج کریں۔", bn: "মনে করিয়ে দিচ্ছি: OTP লিখুন।", ar: "تذكير: أدخل رمز OTP." },
      otpVerified: { en: "Thanks! I've sent the report to your email. You can also download it above anytime.", hi: "धन्यवाद! रिपोर्ट ईमेल पर भेज दी है।", ur: "شکریہ! رپورٹ ای میل پر بھیج دی ہے۔", bn: "ধন্যবাদ! রিপোর্ট ইমেইলে পাঠানো হয়েছে।", ar: "شكراً! أرسلت التقرير إلى بريدك." },
      otpVerifiedNoRep: { en: "Thanks! Your email is verified. How can I help you today?", hi: "धन्यवाद! ईमेल सत्यापित हो गया। आज मैं आपकी कैसे मदद करूँ?", ur: "شکریہ! ایمیل تصدیق ہو گئی۔ آج میں کیسے مدد کروں؟", bn: "ধন্যবাদ! ইমেইল যাচাই হয়েছে। কিভাবে সাহায্য করতে পারি?", ar: "شكراً! تم التحقق من بريدك. كيف أساعدك اليوم؟" },
      otpInvalid: { en: "Invalid or expired code. Please try again.", hi: "अमान्य कोड। पुनः प्रयास करें।", ur: "غلط کوڈ۔ دوبارہ کوشش کریں۔", bn: "অবৈধ কোড। আবার চেষ্টা করুন।", ar: "رمز غير صالح. حاول مرة أخرى." },
      otpSentVerify: { en: "I've sent a 6-digit code to your email. Please enter it to verify and I'll send the report to your inbox.", hi: "ईमेल पर 6-अंकीय कोड भेजा है। दर्ज करें और रिपोर्ट भेज दूंगा।", ur: "6 ہندسوں کا کوڈ ای میل پر بھیجا۔ درج کریں اور رپورٹ بھیجوں گا۔", bn: "6-সংখ্যার কোড ইমেইলে পাঠানো হয়েছে। দিন এবং রিপোর্ট পাঠাব।", ar: "أرسلت 6 أرقام إلى بريدك. أدخله وسأرسل التقرير." },
      otpFailed: { en: "I couldn't send the code. Please check the address and try again.", hi: "कोड नहीं भेजा जा सका। पता जांचें और पुनः प्रयास करें।", ur: "کوڈ نہیں بھیجا جا سکا۔ پتہ چیک کریں۔", bn: "কোড পাঠাতে পারিনি। ঠিকানা যাচাই করুন।", ar: "لم أتمكن من إرسال الرمز. تحقق من العنوان." },
      skipCart: { en: "No problem. You can download the report anytime above.", hi: "कोई बात नहीं। रिपोर्ट कभी भी डाउनलोड करें।", ur: "کوئی بات نہیں۔ رپورٹ کسی وقت ڈاؤن لوڈ کریں۔", bn: "কোনো সমস্যা নেই। রিপোর্ট যেকোনো সময় ডাউনলোড করুন।", ar: "لا بأس. يمكنك تنزيل التقرير في أي وقت." },
      welcomeBack: { en: "Welcome, {name}! How can I help you today?", hi: "{name} जी, आपका स्वागत है! आज मैं आपकी कैसे मदद कर सकता हूँ?", ur: "{name}، خوش آمدید! آج میں آپ کی کیسے مدد کر سکتا ہوں؟", bn: "{name}, আপনাকে স্বাগতম! আজ আপনার কিভাবে সাহায্য করতে পারি?", ar: "مرحباً {name}! كيف يمكنني مساعدتك اليوم؟" },
      validResponse: { en: "Please enter a valid response.", hi: "वैध उत्तर दर्ज करें।", ur: "درست جواب درج کریں۔", bn: "সঠিক উত্তর দিন।", ar: "أدخل إجابة صحيحة." },
      validEmail: { en: "Please enter a valid email address.", hi: "वैध ईमेल पता दर्ज करें।", ur: "درست ای میل پتہ درج کریں۔", bn: "সঠিক ইমেইল ঠিকানা দিন।", ar: "أدخل بريداً إلكترونياً صالحاً." },
      genericError: { en: "Something went wrong. Please try again.", hi: "कुछ गड़बड़ हुई। पुनः प्रयास करें।", ur: "کچھ غلط ہوا۔ دوبارہ کوشش کریں۔", bn: "কিছু সমস্যা হয়েছে। আবার চেষ্টা করুন।", ar: "حدث خطأ. حاول مرة أخرى." },
      selectLanguage: { en: "Please select a language to continue.", hi: "कृपया एक भाषा चुनें।", ur: "براہ کرم ایک زبان منتخب کریں۔", bn: "অনুগ্রহ করে একটি ভাষা নির্বাচন করুন।", ar: "يرجى تحديد اللغة للمتابعة." },
    };
    const lang = selectedLanguage in (map[key] || {}) ? selectedLanguage : 'en';
    return (map[key] || {})[lang] || (map[key] || {})['en'] || key;
  };

  const tName = (name: string) => t('welcomeBack').replace('{name}', name);

  // Warm greeting in the user's selected language — shown after language selection
  const getGreetingForNamePrompt = (languageCode: string): string => {
    const greetings: Record<string, string> = {
      en: "Hello! Welcome to Wellness AI. I'm your personal wellness consultant — here to support your physical, mental, and lifestyle well-being.\n\nMay I know your name so I can address you personally?",
      hi: "नमस्ते! Wellness AI में आपका स्वागत है। मैं आपका व्यक्तिगत वेलनेस सलाहकार हूँ — शारीरिक, मानसिक और जीवनशैली से जुड़ी समस्याओं में आपकी मदद के लिए यहाँ हूँ।\n\nकृपया अपना नाम बताएं ताकि मैं आपको व्यक्तिगत रूप से संबोधित कर सकूँ।",
      ur: "السلام علیکم! Wellness AI میں خوش آمدید۔ میں آپ کا ذاتی ویلنیس مشیر ہوں — جسمانی، ذہنی اور طرزِ زندگی سے متعلق مسائل میں آپ کی مدد کے لیے حاضر ہوں۔\n\nبراہ کرم اپنا نام بتائیں تاکہ میں آپ سے ذاتی طور پر بات کر سکوں۔",
      bn: "নমস্কার! Wellness AI-এ আপনাকে স্বাগতম। আমি আপনার ব্যক্তিগত ওয়েলনেস পরামর্শদাতা — শারীরিক, মানসিক এবং জীবনযাত্রার সুস্থতার বিষয়ে সাহায্য করতে এখানে আছি।\n\nঅনুগ্রহ করে আপনার নাম বলুন যাতে আমি আপনাকে ব্যক্তিগতভাবে সম্বোধন করতে পারি।",
      ar: "مرحباً! أهلاً بك في Wellness AI. أنا مستشارك الشخصي للعافية — هنا لدعم صحتك الجسدية والنفسية وأسلوب حياتك الصحي.\n\nهل يمكنك إخباري باسمك لأتمكن من مخاطبتك بشكل شخصي؟",
    };
    return greetings[languageCode] ?? greetings.en;
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
      addAssistantMessage(prompt);
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
        ur: `آپ سے مل کر خوشی ہوئی، ${firstName}! 😊\n\nآپ کی گفتگو مکمل طور پر نجی اور خفیہ ہے۔\n\nآج آپ کس موضوع پر مدد چاہتے ہیں؟`,
        bn: `আপনার সাথে পরিচয় হয়ে ভালো লাগলো, ${firstName}! 😊\n\nআপনার কথোপকথন সম্পূর্ণ ব্যক্তিগত ও গোপনীয়।\n\nআজ কোন বিষয়ে সাহায্য চাইছেন?`,
        ar: `يسعدني لقاؤك، ${firstName}! 😊\n\nمحادثتك خاصة وسرية تماماً.\n\nما الذي يجمعك بنا اليوم؟ اختر موضوعك الرئيسي:`,
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
        ur: [
          { label: "کم توانائی اور تھکاوٹ", prompt: "مجھے کم توانائی اور تھکاوٹ ہو رہی ہے۔ میں کیا کروں؟" },
          { label: "اسٹیمینا اور کارکردگی", prompt: "میں اپنا اسٹیمینا اور کارکردگی بہتر بنانا چاہتا ہوں۔" },
          { label: "اعتماد اور قریبی صحت", prompt: "مجھے اعتماد اور قریبی صحت سے متعلق مسائل ہیں۔" },
          { label: "ذیابیطس / بلڈ شوگر", prompt: "مجھے ذیابیطس یا بلڈ شوگر کنٹرول میں مدد چاہیے۔" },
          { label: "عمومی طاقت اور بحالی", prompt: "میں اپنی عمومی طاقت اور بحالی بہتر کرنا چاہتا ہوں۔" },
        ],
        bn: [
          { label: "কম শক্তি ও ক্লান্তি", prompt: "আমি কম শক্তি ও ক্লান্তি অনুভব করছি। কী করব?" },
          { label: "স্ট্যামিনা ও পারফরম্যান্স", prompt: "আমি আমার স্ট্যামিনা ও পারফরম্যান্স উন্নত করতে চাই।" },
          { label: "আত্মবিশ্বাস ও ঘনিষ্ঠ সুস্থতা", prompt: "আমার আত্মবিশ্বাস ও ঘনিষ্ঠ সুস্থতা নিয়ে সমস্যা আছে।" },
          { label: "ডায়াবেটিস / রক্তে শর্করা", prompt: "আমার ডায়াবেটিস বা রক্তে শর্করা নিয়ন্ত্রণে সাহায্য দরকার।" },
          { label: "সাধারণ শক্তি ও পুনরুদ্ধার", prompt: "আমি আমার সাধারণ শক্তি ও পুনরুদ্ধার উন্নত করতে চাই।" },
        ],
        ar: [
          { label: "التعب وانخفاض الطاقة", prompt: "أعاني من التعب وانخفاض الطاقة. ماذا أفعل؟" },
          { label: "القدرة على التحمل والأداء", prompt: "أريد تحسين قدرتي على التحمل والأداء." },
          { label: "الثقة بالنفس والصحة الحميمة", prompt: "لدي مخاوف تتعلق بالثقة بالنفس والصحة الحميمة." },
          { label: "السكري / سكر الدم", prompt: "أحتاج مساعدة في إدارة السكري أو مستوى السكر في الدم." },
          { label: "القوة العامة والتعافي", prompt: "أريد تحسين قوتي العامة والتعافي." },
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
        addAssistantMessage(getGreetingForNamePrompt(selectedLanguage));
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
      };

      recognitionRef.current.onend = () => {
        setIsListening(false);
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
            ...(!hasProducts && data.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0
              ? { suggestions: data.suggestions }
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

  const handleVoiceInput = () => {
    if (!recognitionRef.current) {
      alert("Speech recognition not supported in your browser");
      return;
    }

    // If starting voice from the hub, enter voice consultation mode
    if (!chatMode && languageConfirmed) {
      setChatMode('voice');
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
  const greetingLanguages = ['en', 'hi', 'ur', 'bn', 'ar'].map(code =>
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

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ FORMAT TIMESTAMP ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  const formatTime = (date: Date | string) => {
    try {
      return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  };

  // ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ EMBED MODE: Two-panel layout ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬ÃƒÂ¢Ã¢â‚¬ÂÃ¢â€šÂ¬
  if (isEmbedChat) {

    return (
      <div className="wai-frame">
        <div className="wai-root">

          {/* ─ Header (always visible, lives outside panels for mobile) ─ */}
          <div className="wai-header">
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <div className="wai-avatar">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="8" r="4" fill="white" opacity="0.95" />
                  <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" stroke="white" strokeWidth="2.2" strokeLinecap="round" opacity="0.95" />
                </svg>
              </div>
              <span className="wai-online-dot" />
            </div>
            <div style={{ flex: 1 }}>
              <p className="wai-agent-name">Wellness AI</p>
              <p className="wai-agent-status">● Online — ready to help</p>
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
            {/* Mobile: menu dots (shown before language confirmed) */}
            {!languageConfirmed && (
              <button type="button" className="wai-header-menu" aria-label="Menu">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="white"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
              </button>
            )}
          </div>

          {/* ═══ Landing Hub (after language, before mode selection) ═══ */}
          {languageConfirmed && !chatMode && (
            <div className="wai-hub">
              <div className="wai-hub-inner">
                {/* Mic center */}
                <div className="wai-hub-mic-area">
                  <button type="button" onClick={handleVoiceInput} disabled={loading}
                    className={`wai-hub-mic${isListening ? ' wai-hub-mic-active' : ''}`}>
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {isListening
                        ? <><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>
                        : <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></>}
                    </svg>
                  </button>
                  <p className="wai-hub-mic-label">{isListening ? 'Listening — speak now...' : 'Tap to speak with our specialist'}</p>
                </div>

                {/* Two action buttons */}
                <div className="wai-hub-actions">
                  <button type="button" className="wai-hub-btn wai-hub-offers"
                    onClick={() => {
                      setChatMode('offers');
                      setMobileTab('picks');
                      handleSendMessage('Show me all available offers and products');
                    }}>
                    <span className="wai-hub-btn-icon">🎁</span>
                    <span className="wai-hub-btn-title">Offers & Products</span>
                    <span className="wai-hub-btn-desc">Browse all wellness products</span>
                  </button>
                  <button type="button" className="wai-hub-btn wai-hub-consult"
                    onClick={() => setChatMode('consultation')}>
                    <span className="wai-hub-btn-icon">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
                    </span>
                    <span className="wai-hub-btn-title">Consultation</span>
                    <span className="wai-hub-btn-desc">Get personalized wellness advice</span>
                  </button>
                </div>
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
                      messages.map((message) => {
                        const isUser = message.role === 'user';
                        const meta = message.metadata as any;
                        const isProductMsg = meta?.type === 'products';
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
                              {!isUser && !isProductMsg && Array.isArray(meta?.suggestions) && meta.suggestions.length > 0 && (
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
                      })
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

                {/* ─ Voice mic area (center-bottom) ─ */}
                <div className="wai-voice-mic-zone">
                  {/* Live transcription preview */}
                  {isListening && (
                    <div className="wai-voice-live">
                      <span className="wai-voice-live-dot" />
                      <span className="wai-voice-live-text">Listening...</span>
                    </div>
                  )}
                  <button type="button" onClick={handleVoiceInput} disabled={loading}
                    className={`wai-voice-mic-btn${isListening ? ' wai-voice-mic-active' : ''}`}>
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {isListening
                        ? <><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>
                        : <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></>}
                    </svg>
                  </button>
                  <p className="wai-voice-mic-hint">
                    {isListening ? 'Tap to stop' : 'Tap to speak'}
                  </p>
                  {/* Switch to text input */}
                  <button type="button" className="wai-voice-switch-text"
                    onClick={() => setChatMode('consultation')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                    </svg>
                    Switch to text
                  </button>
                </div>
              </div>
            )}

            {/* ══ LEFT PANEL: Chat (text consultation & language selection) ══ */}
            {chatMode !== 'voice' && (
              <div className={`wai-chat${mobileTab === 'chat' ? ' wai-mobile-active' : ''}`}
                style={!chatMode ? { width: '100%', borderRight: 'none' } : undefined}>

                {/* ─ Messages ─ */}
                <div className="wai-messages">
                  <div className="wai-messages-inner">
                    {messages.length === 0 ? (
                      /* Language selector */
                      <div className="wai-welcome">
                        <div className="wai-welcome-icon">
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" fill="#14b8a6" />
                          </svg>
                        </div>
                        <h3 className="wai-welcome-title">👋 Hello / نمستے / مرحباً</h3>
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
                    ) : (
                      messages.map((message) => {
                        const isUser = message.role === 'user';
                        const meta = message.metadata as any;
                        const isProductMsg = meta?.type === 'products';
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
                              {!isUser && !isProductMsg && Array.isArray(meta?.suggestions) && meta.suggestions.length > 0 && (
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
                      })
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
                    <div className="wai-input-wrap">
                      {/* Mic */}
                      <button type="button" onClick={handleVoiceInput} disabled={loading}
                        className={`wai-mic-btn${isListening ? ' wai-mic-active' : ''}`}
                        title={isListening ? 'Stop' : 'Voice input'}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          {isListening
                            ? <><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></>
                            : <><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></>}
                        </svg>
                      </button>
                      <input ref={inputRef} type="text" value={input} onChange={e => setInput(e.target.value)}
                        placeholder={inputPlaceholder}
                        disabled={loading}
                        className="wai-input" />
                      {/* Send */}
                      <button type="submit" disabled={loading || !input.trim()}
                        className="wai-send-btn">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                          <path d="M22 2L11 13" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </div>
                    <p className="wai-input-hint">Powered by Wellness AI</p>
                  </form>
                )}
              </div>
            )}

            {/* ══ RIGHT PANEL: Products (hidden until chatMode is set) ══ */}
            {chatMode && (
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

          {/* ══ Styles ══ */}
          <style>{`
          /* ── Outer frame: fills the full iframe (75% centering is done by widget.js) ── */
          .wai-frame {
            width: 100%;
            height: 100%;
            overflow: hidden;
            display: flex;
            flex-direction: column;
            border-radius: 16px;
            border: 1.5px solid rgba(20,184,166,0.18);
            box-shadow: 0 0 20px rgba(20,184,166,0.12), 0 0 40px rgba(20,184,166,0.05);
          }

          /* ── Root layout ─────────────────────────────── */
          .wai-root {
            display: flex;
            flex-direction: column;
            flex: 1;
            height: 100%;
            overflow: hidden;
            background: #fff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;
            color: #111827;
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
            border-right: 1px solid #e8f4f1;
            background: #fff;
            flex-shrink: 0;
          }

          /* ── Header ──────────────────────────────────── */
          .wai-header {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 14px 10px;
            background: linear-gradient(135deg, #0f766e 0%, #0d9488 40%, #14b8a6 100%);
            flex-shrink: 0;
            box-shadow: 0 2px 12px rgba(15,118,110,0.25), 0 4px 24px rgba(20,184,166,0.15);
          }
          .wai-avatar {
            width: 40px; height: 40px; border-radius: 50%;
            background: rgba(255,255,255,0.18);
            border: 2px solid rgba(255,255,255,0.35);
            display: flex; align-items: center; justify-content: center;
            backdrop-filter: blur(4px);
            animation: wai-avatar-breathe 3s ease-in-out infinite;
          }
          .wai-online-dot {
            position: absolute; bottom: 1px; right: 1px;
            width: 10px; height: 10px;
            background: #22c55e; border-radius: 50%;
            border: 2px solid #0f766e;
            box-shadow: 0 0 0 2px rgba(34,197,94,0.3), 0 0 8px rgba(34,197,94,0.4);
          }
          .wai-agent-name {
            margin: 0; font-size: 13px; font-weight: 700;
            color: #fff; line-height: 1.3;
          }
          .wai-agent-status {
            margin: 0; font-size: 10px; font-weight: 500;
            color: rgba(255,255,255,0.8); letter-spacing: 0.01em;
          }


          /* ── Messages ────────────────────────────────── */
          .wai-messages {
            flex: 1; overflow-y: auto; min-height: 0;
            padding: 14px 12px;
            background: linear-gradient(to bottom, #f0fdf9 0%, #f8fffe 30%, #fff 100%);
          }
          .wai-messages::-webkit-scrollbar { width: 3px; }
          .wai-messages::-webkit-scrollbar-thumb { background: #b2e4df; border-radius: 4px; }
          .wai-messages-inner { display: flex; flex-direction: column; gap: 12px; }

          /* ── Message rows ────────────────────────────── */
          .wai-msg-row { display: flex; align-items: flex-end; gap: 7px; animation: wai-msg-appear 0.3s ease-out; }
          .wai-msg-user-row { justify-content: flex-end; }
          .wai-msg-avatar {
            width: 28px; height: 28px; border-radius: 50%; flex-shrink: 0;
            background: linear-gradient(135deg, #14b8a6 0%, #0f766e 100%);
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 2px 6px rgba(20,184,166,0.3);
          }

          /* ── Bubbles ─────────────────────────────────── */
          .wai-bubble {
            max-width: 82%; padding: 10px 14px;
            border-radius: 18px; position: relative;
            line-height: 1.6;
          }
          .wai-bubble-ai {
            background: #fff;
            border: 1px solid #e4f5f3;
            border-bottom-left-radius: 4px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.06), 0 0 6px rgba(20,184,166,0.06);
          }
          .wai-bubble-user {
            background: linear-gradient(135deg, #134e4a 0%, #0f766e 100%);
            border-bottom-right-radius: 4px;
            box-shadow: 0 3px 12px rgba(19,78,74,0.3);
          }
          .wai-bubble-text {
            margin: 0; font-size: 12.5px; line-height: 1.6;
            white-space: pre-wrap; word-break: break-word;
          }
          .wai-bubble-ai .wai-bubble-text { color: #1f2937; }
          .wai-bubble-user .wai-bubble-text { color: #fff; }
          .wai-time { display: block; margin-top: 5px; font-size: 10px; color: #9ca3af; }
          .wai-time-user { color: rgba(255,255,255,0.5); text-align: right; }

          /* ── Typing indicator ────────────────────────── */
          .wai-typing { display: flex; align-items: center; gap: 5px; padding: 12px 16px; }
          .wai-dot {
            width: 7px; height: 7px; border-radius: 50%; background: #14b8a6;
            animation: wai-bounce 1.3s ease-in-out infinite;
          }
          @keyframes wai-bounce { 0%,80%,100%{transform:translateY(0);opacity:0.5} 40%{transform:translateY(-6px);opacity:1} }

          /* ── Suggestion chips ────────────────────────── */
          .wai-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
          .wai-chip {
            padding: 5px 12px; border-radius: 20px;
            border: 1.5px solid #a7f3d0; background: #f0fdf4;
            color: #065f46; font-size: 11.5px; font-weight: 600;
            cursor: pointer; transition: all 0.15s;
          }
          .wai-chip:hover { background: #14b8a6; border-color: #14b8a6; color: #fff; transform: translateY(-1px); }
          .wai-chip-muted { border-color: #d1d5db; background: #f9fafb; color: #6b7280; }
          .wai-chip-muted:hover { background: #6b7280; border-color: #6b7280; color: #fff; }

          /* ── Welcome screen ──────────────────────────── */
          .wai-welcome {
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; padding: 48px 20px; text-align: center; gap: 16px;
            min-height: 65vh;
          }
          .wai-welcome-icon {
            width: 76px; height: 76px; border-radius: 50%;
            background: linear-gradient(135deg, #e0f7f5 0%, #ccfbf1 100%);
            display: flex; align-items: center; justify-content: center;
            margin-bottom: 8px; box-shadow: 0 4px 16px rgba(20,184,166,0.15);
          }
          .wai-welcome-icon svg {
            width: 40px; height: 40px;
          }
          .wai-welcome-title { margin: 0; font-size: 24px; font-weight: 800; color: #111827; }
          .wai-welcome-sub { margin: 0; font-size: 15px; color: #6b7280; line-height: 1.6; }
          .wai-lang-grid { display: flex; flex-wrap: wrap; gap: 16px; justify-content: center; margin-top: 16px; }
          .wai-lang-btn {
            display: flex; flex-direction: column; align-items: center; gap: 6px;
            padding: 16px 24px; border-radius: 16px;
            border: 1.5px solid #e5e7eb; background: #fafafa;
            cursor: pointer; transition: all 0.18s;
            min-width: 100px;
          }
          .wai-lang-btn:hover { border-color: #14b8a6; background: rgba(20,184,166,0.07); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(20,184,166,0.15); }
          .wai-lang-greeting { font-size: 18px; font-weight: 700; color: #111827; }
          .wai-lang-name { font-size: 12px; color: #9ca3af; font-weight: 400; }

          /* ── Input bar ───────────────────────────────── */
          .wai-input-bar {
            flex-shrink: 0; padding: 10px 12px 12px;
            border-top: 1px solid #e8f4f1; background: #fff;
          }
          .wai-input-wrap {
            display: flex; align-items: center; gap: 6px;
            background: #f8fffe; border: 1.5px solid #b2e4df;
            border-radius: 28px; padding: 6px 6px 6px 12px;
            transition: border-color 0.15s, box-shadow 0.15s;
          }
          .wai-input-wrap:focus-within { border-color: #14b8a6; box-shadow: 0 0 0 3px rgba(20,184,166,0.12), 0 0 12px rgba(20,184,166,0.08); }
          .wai-input {
            flex: 1; min-width: 0; border: none; outline: none;
            background: transparent; font-size: 12.5px; color: #374151;
          }
          .wai-input::placeholder { color: #9ca3af; }
          .wai-mic-btn {
            background: none; border: none; cursor: pointer;
            padding: 3px; color: #9ca3af;
            display: flex; align-items: center; flex-shrink: 0;
            transition: color 0.15s;
          }
          .wai-mic-btn:hover { color: #14b8a6; }
          .wai-mic-active { color: #ef4444 !important; }
          .wai-send-btn {
            width: 34px; height: 34px; border-radius: 50%;
            background: linear-gradient(135deg, #14b8a6 0%, #0f766e 100%);
            border: none; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            flex-shrink: 0; transition: all 0.15s;
            box-shadow: 0 2px 8px rgba(20,184,166,0.35);
          }
          .wai-send-btn:hover:not(:disabled) { transform: scale(1.08); box-shadow: 0 4px 14px rgba(20,184,166,0.45); }
          .wai-send-btn:disabled { opacity: 0.35; cursor: not-allowed; }
          .wai-input-hint { margin: 5px 0 0; text-align: center; font-size: 9.5px; color: #d1d5db; letter-spacing: 0.02em; }

          /* ── Voice panel ───────────────────────────── */
          .wai-voice-panel {
            display: flex; flex-direction: column;
            width: 45%; min-width: 260px;
            border-right: 1px solid #e8f4f1;
            background: #fff; flex-shrink: 0;
          }
          .wai-voice-transcript {
            flex: 1; overflow-y: auto; min-height: 0;
            padding: 14px 12px;
            background: linear-gradient(to bottom, #f0fdf9 0%, #f8fffe 30%, #fff 100%);
          }
          .wai-voice-transcript::-webkit-scrollbar { width: 3px; }
          .wai-voice-transcript::-webkit-scrollbar-thumb { background: #b2e4df; border-radius: 4px; }

          /* Empty state */
          .wai-voice-empty {
            display: flex; flex-direction: column; align-items: center;
            justify-content: center; text-align: center; gap: 10px;
            padding: 40px 16px; min-height: 120px;
          }
          .wai-voice-empty-icon {
            width: 56px; height: 56px; border-radius: 50%;
            background: linear-gradient(135deg, #e0f7f5 0%, #ccfbf1 100%);
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 4px 16px rgba(20,184,166,0.15);
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
            background: linear-gradient(to top, #f0fdf9 0%, #fff 100%);
            border-top: 1px solid #e8f4f1;
          }
          .wai-voice-mic-btn {
            width: 80px; height: 80px; border-radius: 50%;
            background: linear-gradient(135deg, #14b8a6 0%, #0f766e 100%);
            border: none; color: #fff; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 6px 28px rgba(20,184,166,0.35), 0 0 0 6px rgba(20,184,166,0.08);
            transition: all 0.25s;
            animation: wai-voice-breathe 3s ease-in-out infinite;
          }
          .wai-voice-mic-btn:hover:not(:disabled) { transform: scale(1.08); box-shadow: 0 8px 32px rgba(20,184,166,0.45), 0 0 0 8px rgba(20,184,166,0.12); }
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

          /* Switch to text button */
          .wai-voice-switch-text {
            display: flex; align-items: center; gap: 6px;
            padding: 6px 14px; border-radius: 20px;
            border: 1.5px solid #d1d5db; background: #fff;
            color: #6b7280; font-size: 11.5px; font-weight: 600;
            cursor: pointer; transition: all 0.15s;
          }
          .wai-voice-switch-text:hover {
            border-color: #14b8a6; color: #0f766e;
            background: rgba(20,184,166,0.06);
          }

          /* Voice panel animations */
          @keyframes wai-voice-breathe {
            0%, 100% { box-shadow: 0 6px 28px rgba(20,184,166,0.35), 0 0 0 6px rgba(20,184,166,0.08); }
            50% { box-shadow: 0 6px 28px rgba(20,184,166,0.45), 0 0 0 12px rgba(20,184,166,0.06); }
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
            overflow: hidden; background: linear-gradient(to bottom, #f0fdf8 0%, #f8fffe 100%);
            min-width: 0;
          }
          .wai-panel-header {
            padding: 14px 18px 12px; border-bottom: 1px solid #e0f2ee;
            background: rgba(255,255,255,0.7); flex-shrink: 0;
            backdrop-filter: blur(8px);
          }
          .wai-panel-title { margin: 0; font-size: 14px; font-weight: 800; color: #111827; }
          .wai-panel-sub { margin: 3px 0 0; font-size: 11px; color: #6b7280; }
          .wai-cat-badge {
            display: inline-flex; align-items: center; gap: 4px;
            padding: 2px 9px; border-radius: 20px;
            font-size: 10px; font-weight: 700;
            color: #0f766e; background: rgba(20,184,166,0.12);
            border: 1px solid rgba(20,184,166,0.25);
            text-transform: uppercase; letter-spacing: 0.05em;
          }
          .wai-badge-dot { width: 5px; height: 5px; border-radius: 50%; background: #22c55e; }

          /* ── Empty state ─────────────────────────────── */
          .wai-empty-state {
            flex: 1; display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            padding: 30px 20px; text-align: center; gap: 8px;
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
            padding: 7px 16px; border-radius: 22px;
            border: 1.5px solid #d1d5db; background: #fff;
            font-size: 11.5px; font-weight: 600; color: #374151;
            cursor: pointer; transition: all 0.18s;
          }
          .wai-empty-chip:hover { border-color: #14b8a6; color: #0f766e; background: rgba(20,184,166,0.07); transform: translateY(-1px); }

          /* ── Product grid ────────────────────────────── */
          .wai-product-scroll { flex: 1; overflow-y: auto; padding: 14px; }
          .wai-product-scroll::-webkit-scrollbar { width: 3px; }
          .wai-product-scroll::-webkit-scrollbar-thumb { background: #b2e4df; border-radius: 4px; }
          .wai-product-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; align-content: start; }
          .wai-product-card {
            background: #fff; border-radius: 16px; overflow: hidden;
            border: 1px solid #e4f5f3; display: flex; flex-direction: column;
            box-shadow: 0 2px 12px rgba(0,0,0,0.06); transition: all 0.2s;
          }
          .wai-product-card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,0.1); border-color: #b2e4df; }
          .wai-product-img-wrap { position: relative; flex-shrink: 0; }
          .wai-product-img { width: 100%; height: 90px; object-fit: cover; display: block; }
          .wai-product-img-placeholder {
            width: 100%; height: 90px;
            background: linear-gradient(135deg, #e0f7f5 0%, #ccfbf1 100%);
            display: flex; align-items: center; justify-content: center;
            font-size: 28px;
          }
          .wai-best-badge {
            position: absolute; top: 8px; left: 8px;
            padding: 3px 9px; border-radius: 20px;
            background: #134e4a; color: #fff;
            font-size: 9px; font-weight: 700;
            letter-spacing: 0.02em; box-shadow: 0 2px 6px rgba(19,78,74,0.3);
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
            border-color: #14b8a6; background: rgba(20,184,166,0.06); color: #0f766e;
          }
          .wai-variant-active {
            border-color: #14b8a6; background: rgba(20,184,166,0.12); color: #0f766e;
            box-shadow: 0 0 0 1px rgba(20,184,166,0.2);
          }
          .wai-variant-price {
            font-size: 9px; font-weight: 700; color: #0f766e; opacity: 0.8;
          }
          .wai-product-desc { display: none; }
          .wai-product-stars { display: none; }
          .wai-product-price { margin: 2px 0 0; font-size: 13px; font-weight: 800; color: #0f766e; letter-spacing: -0.01em; }
          .wai-product-actions { display: flex; gap: 6px; align-items: center; margin-top: auto; padding-top: 4px; }
          .wai-view-btn {
            width: 34px; height: 34px; border-radius: 10px;
            border: 1.5px solid #e0f2ee; background: #f8fffe;
            display: flex; align-items: center; justify-content: center;
            color: #6b7280; text-decoration: none; flex-shrink: 0;
            transition: all 0.15s;
          }
          .wai-view-btn:hover { border-color: #14b8a6; color: #0f766e; background: rgba(20,184,166,0.08); }
          .wai-cart-btn {
            flex: 1; height: 34px; border-radius: 10px; border: none;
            background: linear-gradient(135deg, #134e4a 0%, #0f766e 100%);
            color: #fff; font-size: 11.5px; font-weight: 700;
            display: flex; align-items: center; justify-content: center; gap: 5px;
            cursor: pointer; transition: all 0.15s;
            box-shadow: 0 2px 8px rgba(19,78,74,0.25);
            letter-spacing: 0.01em;
          }
          .wai-cart-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(19,78,74,0.35); }
          .wai-cart-added { background: #f3f4f6 !important; color: #6b7280 !important; box-shadow: none !important; cursor: not-allowed !important; }
          .wai-cart-adding { background: rgba(20,184,166,0.15) !important; color: #0f766e !important; box-shadow: none !important; cursor: wait !important; }
          .wai-spinner {
            width: 11px; height: 11px; border: 2px solid #0f766e;
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
          @keyframes wai-hub-pulse {
            0%, 100% { box-shadow: 0 0 0 8px rgba(20,184,166,0.15), 0 6px 24px rgba(20,184,166,0.3); }
            50% { box-shadow: 0 0 0 16px rgba(20,184,166,0.06), 0 6px 24px rgba(20,184,166,0.15); }
          }
          @keyframes wai-hub-pulse-active {
            0%, 100% { box-shadow: 0 0 0 8px rgba(239,68,68,0.2), 0 6px 20px rgba(239,68,68,0.3); }
            50% { box-shadow: 0 0 0 18px rgba(239,68,68,0.06), 0 6px 20px rgba(239,68,68,0.15); }
          }

          /* ── Landing Hub ──────────────────────────────── */
          .wai-hub {
            flex: 1; display: flex; align-items: center; justify-content: center;
            background: linear-gradient(to bottom, #f0fdf9 0%, #fff 60%);
            padding: 24px 16px; overflow-y: auto;
          }
          .wai-hub-inner {
            display: flex; flex-direction: column; align-items: center;
            gap: 28px; max-width: 360px; width: 100%; text-align: center;
          }

          /* Hub mic */
          .wai-hub-mic-area {
            display: flex; flex-direction: column; align-items: center; gap: 10px;
          }
          .wai-hub-mic {
            width: 72px; height: 72px; border-radius: 50%;
            background: linear-gradient(135deg, #14b8a6 0%, #0f766e 100%);
            border: none; color: #fff; cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            box-shadow: 0 6px 24px rgba(20,184,166,0.3);
            transition: all 0.25s;
            animation: wai-hub-pulse 2.5s ease-in-out infinite;
          }
          .wai-hub-mic:hover:not(:disabled) { transform: scale(1.1); }
          .wai-hub-mic:disabled { opacity: 0.5; cursor: not-allowed; animation: none; }
          .wai-hub-mic-active {
            background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%) !important;
            animation: wai-hub-pulse-active 1.5s ease-in-out infinite !important;
          }
          .wai-hub-mic-label {
            margin: 0; font-size: 12px; color: #6b7280; font-weight: 500;
            line-height: 1.5; max-width: 200px;
          }

          /* Hub action buttons */
          .wai-hub-actions {
            display: flex; gap: 12px; width: 100%;
          }
          .wai-hub-btn {
            flex: 1; display: flex; flex-direction: column; align-items: center;
            gap: 6px; padding: 18px 12px; border-radius: 16px;
            border: 1.5px solid #e5e7eb; background: #fff;
            cursor: pointer; transition: all 0.2s;
            box-shadow: 0 2px 8px rgba(0,0,0,0.04);
          }
          .wai-hub-btn:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 24px rgba(0,0,0,0.1);
          }
          .wai-hub-btn-icon {
            font-size: 24px; line-height: 1;
            display: flex; align-items: center; justify-content: center;
            width: 48px; height: 48px; border-radius: 50%;
          }
          .wai-hub-btn-title {
            font-size: 13px; font-weight: 700; color: #111827;
          }
          .wai-hub-btn-desc {
            font-size: 10.5px; color: #6b7280; line-height: 1.4;
          }

          /* Offers variant */
          .wai-hub-offers {
            border-color: rgba(251,191,36,0.4);
            background: linear-gradient(to bottom, #fffbeb, #fff);
          }
          .wai-hub-offers:hover { border-color: #f59e0b; }
          .wai-hub-offers .wai-hub-btn-icon {
            background: rgba(251,191,36,0.15);
          }

          /* Consultation variant */
          .wai-hub-consult {
            border-color: rgba(20,184,166,0.3);
            background: linear-gradient(to bottom, #f0fdf9, #fff);
          }
          .wai-hub-consult:hover { border-color: #14b8a6; }
          .wai-hub-consult .wai-hub-btn-icon {
            background: rgba(20,184,166,0.12);
            color: #0f766e;
          }

          /* ── Cart summary ────────────────────────────── */
          .wai-cart-summary {
            display: flex; align-items: center; justify-content: space-between;
            flex-wrap: wrap; gap: 8px;
            padding: 12px 16px; margin-top: 10px; border-radius: 14px;
            background: linear-gradient(135deg, rgba(20,184,166,0.1) 0%, rgba(20,184,166,0.06) 100%);
            border: 1px solid rgba(20,184,166,0.25);
            box-shadow: 0 2px 8px rgba(20,184,166,0.1);
          }
          .wai-cart-count { font-size: 12px; font-weight: 700; color: #134e4a; }
          .wai-cart-link {
            padding: 5px 14px; border-radius: 10px;
            border: 1.5px solid #14b8a6; font-size: 11.5px; font-weight: 700;
            color: #0f766e; background: #fff; text-decoration: none;
            transition: all 0.15s;
          }
          .wai-cart-link:hover { background: #0f766e; color: #fff; }
          .wai-checkout-link { background: #134e4a; color: #fff; border-color: #134e4a; }
          .wai-checkout-link:hover { background: #0f766e; border-color: #0f766e; }

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
            color: #0f766e !important;
            border-color: #fff !important;
            box-shadow: 0 2px 8px rgba(0,0,0,0.12);
          }
          .wai-mobile-tab-active svg { stroke: #0f766e; }

          /* ── Responsive: Mobile ──────────────────────── */
          @media (max-width: 640px) {
            .wai-frame { border-radius: 0; border: none; box-shadow: none; }
            .wai-panels { flex-direction: column; }

            /* Header adjustments */
            .wai-header-menu { display: flex; }
            .wai-mobile-tabs { display: flex; }

            /* Hub: mobile adjustments */
            .wai-hub { padding: 20px 14px; }
            .wai-hub-mic { width: 64px; height: 64px; }
            .wai-hub-mic svg { width: 28px; height: 28px; }
            .wai-hub-actions { gap: 10px; }
            .wai-hub-btn { padding: 14px 10px; border-radius: 14px; }
            .wai-hub-btn-icon { width: 40px; height: 40px; font-size: 20px; }
            .wai-hub-btn-title { font-size: 12px; }
            .wai-hub-btn-desc { font-size: 10px; }

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

            /* Welcome screen: vertically centered, spacious layout */
            .wai-welcome {
              padding: 42px 24px; gap: 12px; flex: 1; min-height: 0;
            }
            .wai-welcome-icon {
              width: 72px; height: 72px; margin-bottom: 8px;
              box-shadow: 0 4px 20px rgba(20,184,166,0.18);
            }
            .wai-welcome-icon svg { width: 36px; height: 36px; }
            .wai-welcome-title { font-size: 22px; }
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

            /* Input bar: match reference design */
            .wai-input-wrap {
              border-radius: 30px; padding: 5px 5px 5px 14px;
            }
            .wai-input { font-size: 13px; }
            .wai-send-btn {
              width: 38px; height: 38px;
            }
            .wai-input-hint { display: none; }

            /* Product grid: single column, larger cards on mobile */
            .wai-product-grid { grid-template-columns: 1fr !important; gap: 14px; }
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
