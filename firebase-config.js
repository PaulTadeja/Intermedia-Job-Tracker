// Copy this file to "firebase-config.js" (same folder) and fill in the values
// from your Firebase project settings — Project settings → General →
// "Your apps" → Web app → SDK setup and configuration → Config.
//
// firebase-config.js is listed in .gitignore so your keys don't get committed —
// that's fine, these values are meant to be public (they identify your project,
// they are not secrets), but keeping them out of git means you can safely
// re-use this same repo folder as a template for other tools later.
//
// After copying, index.html / app.js will pick this file up automatically —
// no other code changes needed.

export const firebaseConfig = {
  apiKey: "AIzaSyCpSnn1bOsqGfg3XhcRS3_yVPi66Xi4ElI",
  authDomain: "intermedia-job-tracker.firebaseapp.com",
  projectId: "intermedia-job-tracker",
  storageBucket: "intermedia-job-tracker.firebasestorage.app",
  messagingSenderId: "965101849642",
  appId: "1:965101849642:web:f1cb17313d438a7e988753",
  measurementId: "G-YY58CFN4X9"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
