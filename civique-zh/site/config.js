// Settings the seller edits. Nothing here is secret.
window.CIVIQUE_CONFIG = {
  price: '14,99 €',      // shown on the unlock page
  payUrl: '',            // Stripe Payment Link. Set its after-payment redirect to: https://YOUR-SITE/?code=XXXX-XXXX-XXXX
  contact: '',           // shown to buyers when payUrl is empty and on the About page, e.g. '微信 your_id'
  seller: '',            // legal name of the seller, shown at the bottom of the About page
  beacon: ''             // optional counting pixel: the app requests beacon + event name once per device (ten_answers, paywall, unlocked, mini_done, exam_done)
};
