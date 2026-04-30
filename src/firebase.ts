// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore"; // <--- REMOVED "/lite" FROM HERE

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAw4bS132JVjTcQSFQezEIAnZD5ns2hJ3E",
  authDomain: "project-0de72b50-0833-4a07-a1f.firebaseapp.com",
  projectId: "project-0de72b50-0833-4a07-a1f",
  storageBucket: "project-0de72b50-0833-4a07-a1f.firebasestorage.app",
  messagingSenderId: "154098853990",
  appId: "1:154098853990:web:aa2195d536467dc51965a7",
  measurementId: "G-Q99DH7206X"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);