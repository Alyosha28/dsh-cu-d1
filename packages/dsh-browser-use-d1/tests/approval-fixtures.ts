export class FakeUserQuestions {
  readonly calls: Array<{ questions: unknown[] }> = []
  constructor(public approve: boolean) {}

  async ask(input: any) {
    input.signal.throwIfAborted()
    this.calls.push(input)
    return {
      answers: input.questions.map(question => ({
        id: question.id,
        selected: [question.options[this.approve ? 0 : 1].label],
      })),
    }
  }
}
