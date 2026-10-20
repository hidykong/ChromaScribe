export async function buildDemoFileMap(options = {}) {
  const includeOriginalFilename = options.includeOriginalFilename === true;
  try {
    const response = await fetch("/api/filemap/load");
    if (response.ok) {
      const data = await response.json();
      const participants = data?.fileMap?.participants;
      if (Array.isArray(participants) && participants.length > 0) {
        if (!includeOriginalFilename) return participants;
        return participants.map((entry) => {
          const transcript = entry.transcript || {};
          if (!transcript.originalFilename && transcript.relativePath) {
            transcript.originalFilename = transcript.relativePath.split("/").pop();
          }
          return { ...entry, transcript };
        });
      }
    }
  } catch (error) {
    console.warn("buildDemoFileMap: failed to load from API", error);
  }

  return [
    {
      participant: "P3",
      audio: { relativePath: "P3_trimmed.m4a" },
      transcript: {
        relativePath: "P3_Clean_Transcripts_trimmed.txt",
        originalFilename: "P3_Clean_Transcripts_trimmed.txt",
      },
    },
    {
      participant: "P6",
      audio: { relativePath: "P6_trimmed.m4a" },
      transcript: {
        relativePath: "P6_Clean_Transcripts_trimmed.txt",
        originalFilename: "P6_Clean_Transcripts_trimmed.txt",
      },
    },
    {
      participant: "P7",
      audio: { relativePath: "P7_trimmed.m4a" },
      transcript: {
        relativePath: "P7_Clean_Transcripts_trimmed.txt",
        originalFilename: "P7_Clean_Transcripts_trimmed.txt",
      },
    },
  ];
}
