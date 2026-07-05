import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
  apiKey: "AIzaSyDIoxgp6P8vrfvNN-kH5uVvF96xV47ecAU",
  authDomain: "misconceptions-lims.firebaseapp.com",
  projectId: "misconceptions-lims",
  storageBucket: "misconceptions-lims.firebasestorage.app",
  messagingSenderId: "994770111923",
  appId: "1:994770111923:web:d5b2ee254fcd7fa7f84fc6"
};

export const missingFirebaseConfig = Object.entries(firebaseConfig)
  .filter(([, value]) => value.length === 0)
  .map(([key]) => key);

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "europe-west1");
