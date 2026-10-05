// Real responses captured from env.AI.run on 3 October 2026 (see PLAN.md, section 3).

export const CHOICE_RESPONSE = {
  model: "clef-flash",
  answers: {
    q: {
      type: "choice",
      choice: "B1",
      probabilities: { A1: 0.0682, A2: 0.0933, B1: 0.4504, B2: 0.2544, C1: 0.0805, C2: 0.0532 },
      confidence: 0.1483,
    },
  },
  usage: { input_tokens: 228, output_tokens: 0 },
};

export const SCORE_RESPONSE = {
  model: "clef-flash",
  answers: {
    q: {
      type: "score",
      score: 2.9951,
      legend: { "0": "Unreadable", "1": "Poor", "2": "Acceptable", "3": "Good", "4": "Natural" },
      probabilities: { "0": 0.0275, "1": 0.0471, "2": 0.2112, "3": 0.331, "4": 0.3832 },
      confidence: 0.1299,
    },
  },
  usage: { input_tokens: 236, output_tokens: 0 },
};

export const INVALID_REQUEST_ERROR =
  '5012: {"error":{"type":"invalid_request","message":"Request body failed validation"}}';
