import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";
import {
  getFirestore, doc, getDoc, getDocs, addDoc, setDoc,
  updateDoc, deleteDoc, collection, query, where, orderBy,
  serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyAHTCiicd4b94rG1-jN0STRbwcrLmkYudo",
  authDomain: "okul-yoklama-sistemi-8081f.firebaseapp.com",
  projectId: "okul-yoklama-sistemi-8081f",
  storageBucket: "okul-yoklama-sistemi-8081f.firebasestorage.app",
  messagingSenderId: "38230047763",
  appId: "1:38230047763:web:dfab058df8928b66be13e6",
};

export const FIREBASE_REGION = "europe-west1";
export const OGRETMEN_REFRESH_MS = 5 * 60 * 1000;
export const YOKLAMA_PENCERE_DK = 15;

export const bugun = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date()).split(".").reverse().join("-");

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, FIREBASE_REGION);

// Re-export Firestore helpers so modules only need one import
export {
  doc, getDoc, getDocs, addDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, serverTimestamp, Timestamp,
  httpsCallable,
};
