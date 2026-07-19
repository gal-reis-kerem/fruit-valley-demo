// Human-sounding customer replies. A random variant is picked each time so the
// bot doesn't feel like a template machine.

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const NEW_ORDER = [
  (o, cutoff) => `קיבלתי את ההזמנה והיא יצאה לליקוט 😊 מספר ההזמנה הוא ${o.id}`,
  (o, cutoff) => `ההזמנה נקלטה ויצאה לליקוט 🙌 מספר ההזמנה שלך: ${o.id}`,
  (o, cutoff) => `קיבלתי! ההזמנה כבר בדרך לליקוט 😊 מספר הזמנה: ${o.id}`,
  (o, cutoff) => `מעולה, ההזמנה התקבלה ויצאה לליקוט 🍎 מספר ההזמנה הוא ${o.id}`,
  (o, cutoff) => `ההזמנה אצלנו ויצאה לליקוט 😊 מספר הזמנה ${o.id} — אפשר לשלוח שינויים עד ${cutoff}`,
];

const ADDITION = [
  (o) => `התוספת נקלטה ושויכה להזמנה שלך שמספרה ${o.id} 😊`,
  (o) => `קיבלתי את התוספת, שויכה להזמנה ${o.id} 👍`,
  (o) => `סגור! התוספת נוספה להזמנה ${o.id} 😊`,
  (o) => `התוספת בפנים 🙌 שויכה להזמנה שמספרה ${o.id}`,
];

const ADDITION_AFTER_PRINT = [
  (o) => `התוספת נקלטה ושויכה להזמנה שלך שמספרה ${o.id} 😊 הדף כבר הודפס, אז עדכנו את המלקטים בקבוצה`,
  (o) => `קיבלתי! התוספת שויכה להזמנה ${o.id} והועברה למלקטים (הדף כבר יצא להדפסה) 👍`,
];

const CANCELLATION = [
  (o) => `ההזמנה ${o.id} בוטלה, עדכנו את המלקטים 🙏`,
  (o) => `בוטל! הזמנה ${o.id} ירדה מהליקוט`,
];

const GENERAL = [
  () => `היי 😊 קיבלתי את ההודעה. אם זו הזמנה — פשוט שלחו את רשימת הפריטים ואטפל בה מיד`,
  () => `הודעתך התקבלה 🙏 לרשימת הזמנה פשוט שלחו את הפריטים ואני אדאג לשאר`,
];

const DOCUMENTED = [
  (o) => `ההזמנה ${o.id} תועדה במלואה (דף מסומן + משלוח ארוז) — תודה! ✅`,
  (o) => `מושלם, קיבלנו את שתי התמונות — הזמנה ${o.id} מתועדת ✅`,
];

module.exports = {
  newOrder: (order, cutoff) => pick(NEW_ORDER)(order, cutoff),
  addition: (order) => pick(ADDITION)(order),
  additionAfterPrint: (order) => pick(ADDITION_AFTER_PRINT)(order),
  cancellation: (order) => pick(CANCELLATION)(order),
  general: () => pick(GENERAL)(),
  documented: (order) => pick(DOCUMENTED)(order),
};
