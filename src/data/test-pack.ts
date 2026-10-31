export const testPack = {
  source:
    "VOKA authored synthetic test fixture; illustrative levels, not a CEFR dataset",
  license: "CC0-1.0",
  version: "test-2026.10",
  language: "en",
  wordCount: 14,
  entries: [
    {
      lemma: "achieve",
      level: "B1",
      GlossNative: "实现",
      GlossTarget: "to succeed in reaching a goal",
      Reading: "/əˈtʃiːv/",
    },
    {
      lemma: "advice",
      level: "B1",
      GlossNative: "建议",
      GlossTarget: "an idea offered to help someone",
      Reading: "/ədˈvaɪs/",
    },
    {
      lemma: "afford",
      level: "B1",
      GlossNative: "负担得起",
      GlossTarget: "to have enough money for something",
      Reading: "/əˈfɔrd/",
    },
    {
      lemma: "arrange",
      level: "B1",
      GlossNative: "安排",
      GlossTarget: "to plan how something will happen",
      Reading: "/əˈreɪndʒ/",
    },
    {
      lemma: "behave",
      level: "B1",
      GlossNative: "表现",
      GlossTarget: "to act in a particular way",
      Reading: "/bɪˈheɪv/",
    },
    {
      lemma: "benefit",
      level: "B1",
      GlossNative: "益处",
      GlossTarget: "something that helps you",
      Reading: "/ˈbɛnəfɪt/",
    },
    {
      lemma: "challenge",
      level: "B1",
      GlossNative: "挑战",
      GlossTarget: "something difficult to do",
      Reading: "/ˈtʃælɪndʒ/",
    },
    {
      lemma: "compare",
      level: "B1",
      GlossNative: "比较",
      GlossTarget: "to look at how things differ",
      Reading: "/kəmˈpɛr/",
    },
    {
      lemma: "consider",
      level: "B1",
      GlossNative: "考虑",
      GlossTarget: "to think carefully about something",
      Reading: "/kənˈsɪdər/",
    },
    {
      lemma: "develop",
      level: "B1",
      GlossNative: "发展",
      GlossTarget: "to grow or improve",
      Reading: "/dɪˈvɛləp/",
    },
    {
      lemma: "encourage",
      level: "B1",
      GlossNative: "鼓励",
      GlossTarget: "to give someone confidence",
      Reading: "/ɪnˈkɜrɪdʒ/",
    },
    {
      lemma: "improve",
      level: "B1",
      GlossNative: "改善",
      GlossTarget: "to make something better",
      Reading: "/ɪmˈpruv/",
    },
    {
      lemma: "apple",
      level: "A2",
      GlossNative: "苹果",
      GlossTarget: "a round fruit",
      Reading: "/ˈæpəl/",
    },
    {
      lemma: "travel",
      level: "A2",
      GlossNative: "旅行",
      GlossTarget: "to go from place to place",
      Reading: "/ˈtrævəl/",
    },
  ],
};

/** Deliberately tiny fixture only; production lemmatization is a later ticket. */
export const testInflections: Record<string, string[]> = {
  achieved: ["achieve"],
  achieving: ["achieve"],
  improved: ["improve"],
  abandoning: ["abandon"],
};

/** Extra reading-only fixture: not part of the B1 import pack. */
export const testReadingEntries = [
  {
    lemma: "abandon",
    level: "B2",
    GlossNative: "放弃",
    GlossTarget: "to leave something behind",
    Reading: "",
  },
];
