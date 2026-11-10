// Suggestions only. The target language field accepts any language name.
const LANGUAGES = [
  "English", "Spanish", "French", "German", "Italian", "Portuguese", "Dutch",
  "Swedish", "Norwegian", "Danish", "Finnish", "Polish", "Czech", "Hungarian",
  "Romanian", "Greek", "Turkish", "Ukrainian", "Russian", "Arabic", "Hebrew",
  "Hindi", "Bengali", "Urdu", "Thai", "Vietnamese", "Indonesian",
  "Chinese (Simplified)", "Chinese (Traditional)", "Japanese", "Korean",
  "Afrikaans", "Swahili",
];

function fillLanguageList(datalist) {
  for (const name of LANGUAGES) {
    const opt = document.createElement("option");
    opt.value = name;
    datalist.appendChild(opt);
  }
}
